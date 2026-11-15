import { isOpenCaseStatus, replayCase } from "../core/case-core.ts";
import type { CaseEvent } from "../core/types.ts";
import { evaluateCaseSla, type SlaStage } from "../operations/sla.ts";
import type { StoredCase } from "../persistence/types.ts";
import type { OutboxListEntry } from "./in-memory-stores.ts";
import type { SlaPolicyResolver } from "./projections.ts";
import type { PlatformAuditEntry, SignalRecord, StaffNotification, StaffNotificationPayload } from "./types.ts";

/**
 * Duration statistic over a defined cohort.
 * - count: cohort members that reached the milestone (the denominator
 *   of mean / median / p90)
 * - missing: cohort members that have not reached it (still open, or
 *   skipped the milestone). They are excluded, not imputed.
 * Percentiles use the nearest-rank method.
 */
export interface DurationStat {
  count: number;
  missing: number;
  meanMinutes: number | null;
  medianMinutes: number | null;
  p90Minutes: number | null;
}

export interface CareOpsAnalytics {
  period: {
    from: string;
    to: string;
    observedDays: number;
    /** Cohort definition so numbers are never read out of context. */
    cohort: string;
  };
  facilityId: string | null;
  signals: {
    received: number;
    createdCase: number;
    linkedToOpenCase: number;
    dismissed: number;
    pendingDecision: number;
    /** Identical re-deliveries suppressed by idempotency. */
    suppressedReplays: number;
  };
  cases: {
    created: number;
    resolved: number;
    closed: number;
    unresolved: number;
    reopened: number;
    /** Open Cases (any creation date) with an active SLA breach at `to`. */
    overdueOpenAtEnd: number;
    escalatedInPeriod: number;
  };
  durations: {
    timeToAcknowledge: DurationStat;
    timeToAssignment: DurationStat;
    timeToResolution: DurationStat;
  };
  handoffs: {
    requested: number;
    accepted: number;
    declined: number;
    cancelled: number;
    /** Requests in the period still not accepted at `to`. */
    unacceptedAtEnd: number;
  };
  /**
   * Internal response targets (facility-defined, not clinical standards):
   * how many Cases of the cohort met each stage's target by the end of
   * the period. Always shown with its denominators.
   */
  sla: {
    stages: SlaStageCompliance[];
    /** true when a facility in scope still runs on unapproved (仮設定) thresholds. */
    provisionalThresholds: boolean;
    note: string;
  };
  /**
   * Staff-notification delivery (null for roles that may not see
   * delivery status).
   */
  notifications: NotificationStats | null;
  /** AI assistance usage, from the audit log. Humans approve every use. */
  ai: {
    generated: number;
    failed: number;
    approved: number;
    /** Approved after the reviewer edited the text. */
    approvedWithEdits: number;
    rejected: number;
    /** Generated in the period and not reviewed by its end. */
    awaitingReview: number;
    truncated: boolean;
  };
  ownership: {
    /** Open Cases whose assignee / handoff target cannot act right now. */
    assigneeUnavailableNow: number;
  };
  frequency: {
    signalsPerWeek: number | null;
    casesPerWeek: number | null;
    /** Weekly rates are suppressed when the window is shorter than this. */
    minimumObservedDays: number;
    note: string;
  };
  limitations: string[];
}

export interface SlaStageCompliance {
  stage: SlaStage;
  /** Cohort Cases that entered the stage before the end of the period. */
  applicable: number;
  met: number;
  /** Completed late, or still open past the target at the end. */
  breached: number;
  /** Still inside the target at the end of the period. */
  pending: number;
  /** met / (met + breached); null when nothing is decided yet. */
  complianceRate: number | null;
}

export interface NotificationStats {
  /** Delivered to every channel within the period. */
  deliveredInPeriod: number;
  /** Of those, repeat notifications for work nobody had acted on. */
  renotificationsInPeriod: number;
  byKind: Record<StaffNotification["kind"], number>;
  /** Snapshot at evaluation time (not limited to the period). */
  undeliveredNow: { retrying: number; deadLetter: number; queued: number };
  /** true when the store returned as many rows as requested (older rows may be missing). */
  truncated: boolean;
}

export const SLA_STAGES: readonly SlaStage[] = ["acknowledge", "assign", "first_action", "handoff_accept", "complete"];

const DAY_MS = 86_400_000;
const MIN_DAYS_FOR_RATE = 7;

function minutes(ms: number): number {
  return Math.round((ms / 60_000) * 10) / 10;
}

function nearestRank(sorted: readonly number[], percentile: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((percentile / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

export function durationStat(values: readonly (number | null)[]): DurationStat {
  const present = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  const missing = values.length - present.length;
  if (present.length === 0) {
    return { count: 0, missing, meanMinutes: null, medianMinutes: null, p90Minutes: null };
  }
  const mean = present.reduce((sum, value) => sum + value, 0) / present.length;
  const mid = present.length / 2;
  const median = present.length % 2 === 0
    ? (present[mid - 1]! + present[mid]!) / 2
    : present[Math.floor(mid)]!;
  return {
    count: present.length,
    missing,
    meanMinutes: minutes(mean),
    medianMinutes: minutes(median),
    p90Minutes: minutes(nearestRank(present, 90)!),
  };
}

function firstEventAt(
  events: readonly CaseEvent[],
  type: CaseEvent["type"],
  untilMs: number,
): number | null {
  const event = events.find((item) => item.type === type && Date.parse(item.at) < untilMs);
  return event ? Date.parse(event.at) : null;
}

function inWindow(value: string, fromMs: number, toMs: number): boolean {
  const ms = Date.parse(value);
  return ms >= fromMs && ms < toMs;
}

const NOTIFICATION_KINDS: readonly StaffNotification["kind"][] = [
  "critical_unacknowledged",
  "sla_breach",
  "manual_escalation",
  "assignee_unavailable",
];

function notificationStats(
  deliveries: { entries: readonly OutboxListEntry[]; truncated: boolean },
  facilityId: string | null,
  fromMs: number,
  toMs: number,
): NotificationStats {
  const byKind = Object.fromEntries(NOTIFICATION_KINDS.map((kind) => [kind, 0])) as Record<StaffNotification["kind"], number>;
  const stats: NotificationStats = {
    deliveredInPeriod: 0,
    renotificationsInPeriod: 0,
    byKind,
    undeliveredNow: { retrying: 0, deadLetter: 0, queued: 0 },
    truncated: deliveries.truncated,
  };
  for (const entry of deliveries.entries) {
    const payload = entry.payload as Partial<StaffNotificationPayload>;
    if (facilityId && payload.facilityId !== facilityId) continue;
    if (entry.status === "failed") stats.undeliveredNow.retrying += 1;
    else if (entry.status === "dead_letter") stats.undeliveredNow.deadLetter += 1;
    else if (entry.status !== "delivered") stats.undeliveredNow.queued += 1;
    if (entry.status !== "delivered" || !entry.deliveredAt || !inWindow(entry.deliveredAt, fromMs, toMs)) continue;
    stats.deliveredInPeriod += 1;
    if (/:r\d+$/.test(entry.deliveryKey)) stats.renotificationsInPeriod += 1;
    if (payload.kind && payload.kind in byKind) byKind[payload.kind] += 1;
  }
  return stats;
}

function aiUsage(
  audit: { entries: readonly PlatformAuditEntry[]; truncated: boolean },
  facilityId: string | null,
  fromMs: number,
  toMs: number,
): CareOpsAnalytics["ai"] {
  const usage = { generated: 0, failed: 0, approved: 0, approvedWithEdits: 0, rejected: 0, awaitingReview: 0, truncated: audit.truncated };
  const generatedIds = new Set<string>();
  const reviewedIds = new Set<string>();
  for (const entry of audit.entries) {
    if (entry.targetType !== "ai_draft") continue;
    if (facilityId && entry.facilityId !== facilityId) continue;
    // Reviews up to the end of the period settle a draft, whenever it was generated.
    if ((entry.action === "ai_draft.approved" || entry.action === "ai_draft.rejected") && Date.parse(entry.at) < toMs) {
      reviewedIds.add(entry.targetId);
    }
    if (!inWindow(entry.at, fromMs, toMs)) continue;
    switch (entry.action) {
      case "ai_draft.generated":
        usage.generated += 1;
        generatedIds.add(entry.targetId);
        break;
      case "ai_draft.failed":
        usage.failed += 1;
        break;
      case "ai_draft.approved":
        usage.approved += 1;
        if ((entry.after as { edited?: unknown } | null)?.edited === true) usage.approvedWithEdits += 1;
        break;
      case "ai_draft.rejected":
        usage.rejected += 1;
        break;
      default:
        break;
    }
  }
  usage.awaitingReview = [...generatedIds].filter((id) => !reviewedIds.has(id)).length;
  return usage;
}

export function computeCareOpsAnalytics(input: {
  cases: readonly StoredCase[];
  signals: readonly SignalRecord[];
  from: string;
  to: string;
  facilityId: string | null;
  policyFor: SlaPolicyResolver;
  /** Evaluation clock; "at end" metrics use min(to, now). */
  now: string;
  /** Whether a facility has approved its own thresholds. */
  slaApprovedFor?: (facilityId: string | null) => boolean;
  /** Staff-notification outbox rows (null: viewer may not see delivery). */
  deliveries?: { entries: readonly OutboxListEntry[]; truncated: boolean } | null;
  auditEntries?: { entries: readonly PlatformAuditEntry[]; truncated: boolean };
  assigneeUnavailableNow?: number;
}): CareOpsAnalytics {
  const fromMs = Date.parse(input.from);
  const toMs = Date.parse(input.to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    throw new Error("Analytics period must satisfy from < to");
  }

  const scopedCases = input.cases.filter(
    (stored) => !input.facilityId || stored.aggregate.facilityId === input.facilityId,
  );
  const scopedSignals = input.signals.filter(
    (signal) => !input.facilityId || signal.facilityId === input.facilityId,
  );
  const periodSignals = scopedSignals.filter((signal) => inWindow(signal.receivedAt, fromMs, toMs));
  const cohort = scopedCases.filter((stored) => inWindow(stored.aggregate.createdAt, fromMs, toMs));

  const tta: (number | null)[] = [];
  const tassign: (number | null)[] = [];
  const tresolve: (number | null)[] = [];
  let resolved = 0;
  let closed = 0;
  let unresolved = 0;

  for (const stored of cohort) {
    const created = Date.parse(stored.aggregate.createdAt);
    const ack = firstEventAt(stored.events, "acknowledged", toMs);
    const assigned = firstEventAt(stored.events, "assigned", toMs);
    const completed = firstEventAt(stored.events, "completed", toMs);
    tta.push(ack === null ? null : ack - created);
    tassign.push(assigned === null ? null : assigned - created);
    tresolve.push(completed === null ? null : completed - created);
    if (completed !== null) resolved += 1;
    if (firstEventAt(stored.events, "closed", toMs) !== null) closed += 1;
    if (completed === null) unresolved += 1;
  }

  let reopened = 0;
  let escalated = 0;
  let requested = 0;
  let accepted = 0;
  let declined = 0;
  let cancelled = 0;
  let unacceptedAtEnd = 0;

  for (const stored of scopedCases) {
    const events = stored.events;
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index]!;
      if (!inWindow(event.at, fromMs, toMs)) continue;
      switch (event.type) {
        case "reopened":
          reopened += 1;
          break;
        case "escalated":
          escalated += 1;
          break;
        case "handoff_accepted":
          accepted += 1;
          break;
        case "handoff_declined":
          declined += 1;
          break;
        case "handoff_cancelled":
          cancelled += 1;
          break;
        case "handoff_requested": {
          requested += 1;
          const resolution = events
            .slice(index + 1)
            .find(
              (later) =>
                (later.type === "handoff_accepted" ||
                  later.type === "handoff_declined" ||
                  later.type === "handoff_cancelled" ||
                  later.type === "reassigned") &&
                Date.parse(later.at) < toMs,
            );
          if (!resolution) unacceptedAtEnd += 1;
          break;
        }
        default:
          break;
      }
    }
  }

  const endIso = new Date(Math.min(toMs, Date.parse(input.now))).toISOString();
  const overdueOpenAtEnd = scopedCases.filter((stored) => {
    if (!isOpenCaseStatus(stored.aggregate.status)) return false;
    if (Date.parse(stored.aggregate.createdAt) >= toMs) return false;
    return evaluateCaseSla(
      stored.aggregate,
      stored.events,
      input.policyFor(stored.aggregate.facilityId ?? null),
      endIso,
    ).hasActiveBreach;
  }).length;

  // Internal-target compliance of the cohort, evaluated on the history as
  // it stood at the end of the period (later events do not count).
  const stageCounts = new Map(SLA_STAGES.map((stage) => [stage, { applicable: 0, met: 0, breached: 0, pending: 0 }]));
  let provisionalThresholds = false;
  for (const stored of cohort) {
    const facilityId = stored.aggregate.facilityId ?? null;
    if (input.slaApprovedFor && !input.slaApprovedFor(facilityId)) provisionalThresholds = true;
    const eventsAtEnd = stored.events.filter((event) => Date.parse(event.at) < toMs);
    if (eventsAtEnd.length === 0) continue;
    const evaluation = evaluateCaseSla(replayCase(eventsAtEnd), eventsAtEnd, input.policyFor(facilityId), endIso);
    for (const checkpoint of evaluation.checkpoints) {
      const counts = stageCounts.get(checkpoint.stage);
      if (!counts || checkpoint.state === "not_applicable") continue;
      counts.applicable += 1;
      counts[checkpoint.state] += 1;
    }
  }
  const stages: SlaStageCompliance[] = SLA_STAGES.map((stage) => {
    const counts = stageCounts.get(stage)!;
    const decided = counts.met + counts.breached;
    return { stage, ...counts, complianceRate: decided === 0 ? null : Math.round((counts.met / decided) * 1000) / 1000 };
  });

  const notifications = input.deliveries ? notificationStats(input.deliveries, input.facilityId, fromMs, toMs) : null;
  const ai = aiUsage(input.auditEntries ?? { entries: [], truncated: false }, input.facilityId, fromMs, toMs);

  const observedDays = Math.round(((toMs - fromMs) / DAY_MS) * 10) / 10;
  const weeks = (toMs - fromMs) / (7 * DAY_MS);
  const rateAllowed = observedDays >= MIN_DAYS_FOR_RATE;

  return {
    period: {
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      observedDays,
      cohort: "期間内に作成されたCase（所要時間・解決/未解決の母集団）。イベント件数は期間内に発生したイベントを集計。",
    },
    facilityId: input.facilityId,
    signals: {
      received: periodSignals.length,
      createdCase: periodSignals.filter((signal) => signal.disposition === "case_created").length,
      linkedToOpenCase: periodSignals.filter((signal) => signal.disposition === "linked").length,
      dismissed: periodSignals.filter((signal) => signal.disposition === "dismissed").length,
      pendingDecision: periodSignals.filter((signal) => signal.disposition === "pending").length,
      suppressedReplays: periodSignals.reduce((sum, signal) => sum + signal.replayCount, 0),
    },
    cases: {
      created: cohort.length,
      resolved,
      closed,
      unresolved,
      reopened,
      overdueOpenAtEnd,
      escalatedInPeriod: escalated,
    },
    durations: {
      timeToAcknowledge: durationStat(tta),
      timeToAssignment: durationStat(tassign),
      timeToResolution: durationStat(tresolve),
    },
    handoffs: {
      requested,
      accepted,
      declined,
      cancelled,
      unacceptedAtEnd,
    },
    sla: {
      stages,
      provisionalThresholds,
      note: "達成率 = 目標内に完了した件数 ÷（目標内に完了 + 超過）。期間末時点で目標内かつ未完了のCaseは分母に含めません。同じ段階を複数回通ったCaseは最新の1回を数えます。",
    },
    notifications,
    ai,
    ownership: { assigneeUnavailableNow: input.assigneeUnavailableNow ?? 0 },
    frequency: {
      signalsPerWeek: rateAllowed ? Math.round((periodSignals.length / weeks) * 10) / 10 : null,
      casesPerWeek: rateAllowed ? Math.round((cohort.length / weeks) * 10) / 10 : null,
      minimumObservedDays: MIN_DAYS_FOR_RATE,
      note: rateAllowed
        ? `週あたり件数 = 期間内件数 ÷ 観測期間(${observedDays}日 = ${Math.round(weeks * 100) / 100}週)`
        : `観測期間が${MIN_DAYS_FOR_RATE}日未満のため週換算を表示しません`,
    },
    limitations: [
      "所要時間は業務記録上のタイムスタンプに基づく指標であり、事故削減率や業務削減率を示すものではありません。",
      "未到達（missing）のCaseは平均・中央値・P90の計算から除外しています。",
      "SLA期限は施設が設定した内部対応目標であり、臨床的基準ではありません。",
      "目標達成率は記録上の時刻に基づく運用指標であり、ケアの質や安全性を直接示すものではありません。件数が少ない期間の率は参考値です。",
      "通知の「配信」はすべての通知チャネルへの送信完了を指し、職員が内容を読んだことを示すものではありません。",
      "AI支援の件数は監査ログに基づきます。AIの下書きは職員が承認した場合のみ対応履歴に反映されます。",
    ],
  };
}
