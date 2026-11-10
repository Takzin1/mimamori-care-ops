import { isOpenCaseStatus } from "../core/case-core.ts";
import type { CaseEvent } from "../core/types.ts";
import { evaluateCaseSla } from "../operations/sla.ts";
import type { StoredCase } from "../persistence/types.ts";
import type { SlaPolicyResolver } from "./projections.ts";
import type { SignalRecord } from "./types.ts";

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
  frequency: {
    signalsPerWeek: number | null;
    casesPerWeek: number | null;
    /** Weekly rates are suppressed when the window is shorter than this. */
    minimumObservedDays: number;
    note: string;
  };
  limitations: string[];
}

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

export function computeCareOpsAnalytics(input: {
  cases: readonly StoredCase[];
  signals: readonly SignalRecord[];
  from: string;
  to: string;
  facilityId: string | null;
  policyFor: SlaPolicyResolver;
  /** Evaluation clock; "at end" metrics use min(to, now). */
  now: string;
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
    ],
  };
}
