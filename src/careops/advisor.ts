import { COMMAND_ROLES } from "../access/policy.ts";
import type { StaffRole } from "../access/types.ts";
import type { CaseCapabilitiesProjection } from "../application/capabilities.ts";
import { projectCaseEvidence } from "../core/audit-trail.ts";
import { isOpenCaseStatus } from "../core/case-core.ts";
import type {
  CaseAggregate,
  CaseCommandType,
  CaseEvent,
} from "../core/types.ts";
import type { CaseSlaEvaluation, SlaStage } from "../operations/sla.ts";

/**
 * Situation digest and next-action candidates for a Case.
 *
 * Human-centred by construction:
 * - Deterministic rules over recorded, structured state (status, owners,
 *   timers, counters). No free text is interpreted and no LLM is used.
 * - It never changes a Case. Every candidate maps to an ordinary command
 *   that a staff member with the right role must execute and confirm.
 * - It never diagnoses, never sets or proposes a priority value, and
 *   never decides urgency. "attention" below is operational (something is
 *   overdue or nobody can act), not clinical.
 */

export const ADVISOR_ENGINE = { engine: "rules", version: "careops-advisor-v1" } as const;

export const ADVISOR_DISCLAIMER =
  "記録された状態と施設の設定から機械的に導いた候補です。診断や緊急度の判断は行いません。実行するかどうかは、権限を持つ職員が判断してください。";

export interface SituationFact {
  key: string;
  label: string;
  value: string;
}

export interface NextActionCandidate {
  id: string;
  title: string;
  /** Why this is listed, in terms of recorded facts only. */
  reason: string;
  /** Keys of the situation facts the rule used. */
  basis: string[];
  /** Command a human would execute; null for a check that needs no command. */
  command: CaseCommandType | null;
  requiredRoles: StaffRole[];
  /** Whether the current viewer may execute it right now. */
  executableByViewer: boolean;
  /** Operational attention (overdue / nobody can act), not clinical urgency. */
  attention: boolean;
}

export interface CaseAdvice {
  generatedBy: typeof ADVISOR_ENGINE;
  disclaimer: string;
  situation: SituationFact[];
  candidates: NextActionCandidate[];
}

export interface AdviseCaseInput {
  aggregate: CaseAggregate;
  events: readonly CaseEvent[];
  sla: CaseSlaEvaluation;
  capabilities: CaseCapabilitiesProjection;
  ownership: { assigneeUnavailable: boolean; handoffTargetUnavailable: boolean };
  pendingDraftCount: number;
  slaApproved: boolean;
  now: string;
}

const STATUS_LABEL: Record<CaseAggregate["status"], string> = {
  NEW: "未確認",
  ACKNOWLEDGED: "確認済み",
  TRIAGED: "判断済み",
  ASSIGNED: "担当割当済み",
  IN_PROGRESS: "対応中",
  HANDOFF_PENDING: "引継ぎ待ち",
  COMPLETED: "解決済み",
  CLOSED: "クローズ",
};

const PRIORITY_LABEL = { critical: "重大", high: "高", normal: "中", low: "低" } as const;

const STAGE_LABEL: Record<SlaStage, string> = {
  acknowledge: "確認",
  assign: "担当割当",
  first_action: "初動",
  handoff_accept: "引継ぎ受領",
  complete: "解決",
};

function minutesBetween(from: string, to: string): number {
  return Math.max(0, Math.floor((Date.parse(to) - Date.parse(from)) / 60_000));
}

function duration(minutes: number): string {
  if (minutes < 60) return `${minutes}分`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}時間${rest}分` : `${hours}時間`;
}

function situationOf(input: AdviseCaseInput): SituationFact[] {
  const { aggregate, sla, now } = input;
  const facts: SituationFact[] = [
    { key: "status", label: "ステータス", value: STATUS_LABEL[aggregate.status] },
    {
      key: "priority",
      label: "優先度（職員または受付ルールが設定）",
      value: `${PRIORITY_LABEL[aggregate.priority]}／根拠: ${aggregate.priorityRationale ?? "未入力"}`,
    },
    { key: "assignee", label: "担当者", value: aggregate.assigneeId ?? "未割当" },
  ];
  if (aggregate.handoffTargetId) {
    facts.push({
      key: "handoff",
      label: "引継ぎ",
      value: `${aggregate.handoffTargetId} の受領待ち（依頼から${duration(minutesBetween(aggregate.handoffRequestedAt ?? now, now))}）`,
    });
  }
  facts.push({
    key: "lastChecked",
    label: "本人の状態確認（最終）",
    value: aggregate.lastCheckedAt ? `${duration(minutesBetween(aggregate.lastCheckedAt, now))}前` : "記録なし",
  });
  if (sla.currentStage) {
    const checkpoint = sla.checkpoints.find((item) => item.stage === sla.currentStage);
    const overdue = checkpoint?.state === "breached" && checkpoint.completedAt === null;
    facts.push({
      key: "deadline",
      label: `内部対応期限（${STAGE_LABEL[sla.currentStage]}${input.slaApproved ? "" : "・仮設定"}）`,
      value: !checkpoint?.dueAt
        ? "—"
        : overdue
          ? `${duration(Math.floor(checkpoint.overdueMs / 60_000))}超過`
          : `あと${duration(minutesBetween(now, checkpoint.dueAt))}`,
    });
  }
  if (aggregate.escalation) {
    facts.push({ key: "escalation", label: "エスカレーション", value: `継続中（${aggregate.escalation.escalatedBy}、${duration(minutesBetween(aggregate.escalation.escalatedAt, now))}前）` });
  }
  if (aggregate.linkedSignalCount > 0) {
    facts.push({ key: "linkedSignals", label: "同じ対象者からの追加通知", value: `${aggregate.linkedSignalCount}件` });
  }
  facts.push({ key: "evidence", label: "記録済みの証跡", value: `${projectCaseEvidence(input.events).length}件` });
  if (input.ownership.assigneeUnavailable) facts.push({ key: "assigneeUnavailable", label: "担当者の状態", value: "対応できない状態（無効化または施設外）" });
  if (input.ownership.handoffTargetUnavailable) facts.push({ key: "targetUnavailable", label: "引継ぎ先の状態", value: "対応できない状態（無効化または施設外）" });
  if (input.pendingDraftCount > 0) facts.push({ key: "pendingDrafts", label: "確認待ちのAI下書き", value: `${input.pendingDraftCount}件` });
  return facts;
}

export function adviseCase(input: AdviseCaseInput): CaseAdvice {
  const { aggregate, sla, ownership } = input;
  const executable = new Set(input.capabilities.commands.map((command) => command.type));
  const breached = (stage: SlaStage) => sla.breachedStages.includes(stage);
  const candidates: NextActionCandidate[] = [];
  const add = (
    id: string,
    command: CaseCommandType | null,
    title: string,
    reason: string,
    basis: string[],
    attention = false,
  ) => {
    if (candidates.some((candidate) => candidate.id === id)) return;
    candidates.push({
      id,
      title,
      reason,
      basis,
      command,
      requiredRoles: command ? [...COMMAND_ROLES[command]] : [],
      executableByViewer: command ? executable.has(command) : false,
      attention,
    });
  };

  // Nobody can act: always first, whatever the status.
  if (ownership.assigneeUnavailable) {
    add("reassign_unavailable_assignee", "reassign", "担当を変更する",
      "現在の担当者は対応できない状態です。責任を持って対応できる職員への変更が必要です。", ["assignee", "assigneeUnavailable"], true);
  }
  if (ownership.handoffTargetUnavailable) {
    add("cancel_handoff_unavailable_target", "cancel_handoff", "引継ぎ依頼を取り消す",
      "引継ぎ先が対応できない状態です。依頼を取り消して別の職員へ引き継いでください。", ["handoff", "targetUnavailable"], true);
    add("reassign_unavailable_target", "reassign", "担当を変更する（管理者・受付）",
      "引継ぎ先が対応できない状態です。管理者・受付が担当を直接変更できます。", ["handoff", "targetUnavailable"], true);
  }

  switch (aggregate.status) {
    case "NEW":
      add("acknowledge", "acknowledge", "内容を確認して受付する",
        breached("acknowledge") ? "確認の内部対応期限を超過しています。職員による確認がまだ記録されていません。" : "職員による確認がまだ記録されていません。",
        ["status", "deadline"], breached("acknowledge") || aggregate.priority === "critical");
      break;

    case "ACKNOWLEDGED":
      add("triage", "triage", "判断を記録する（区分・優先度・根拠）",
        "確認済みですが、区分と優先度の根拠がまだ記録されていません。", ["status", "priority"]);
      add("assign", "assign", "担当を割り当てる",
        breached("assign") ? "担当割当の内部対応期限を超過しています。" : "担当者がまだ決まっていません。", ["assignee", "deadline"], breached("assign"));
      break;

    case "TRIAGED":
      add("assign", "assign", "担当を割り当てる",
        breached("assign") ? "担当割当の内部対応期限を超過しています。" : "判断は記録済みで、担当者がまだ決まっていません。", ["assignee", "deadline"], breached("assign"));
      break;

    case "ASSIGNED":
      if (!ownership.assigneeUnavailable) {
        add("start_action", "start_action", "対応を開始する",
          breached("first_action") ? "初動の内部対応期限を超過しています。担当者による対応開始が記録されていません。" : "担当者による対応開始がまだ記録されていません。",
          ["assignee", "deadline"], breached("first_action"));
        if (breached("first_action")) {
          add("reassign_no_start", "reassign", "担当者に状況を確認し、必要なら担当を変更する",
            "初動の期限を過ぎても対応開始の記録がありません。担当者が動けない場合は担当変更を検討してください。", ["assignee", "deadline"], true);
        }
      }
      break;

    case "IN_PROGRESS":
      if (!aggregate.lastCheckedAt) {
        add("record_observation", "add_note", "本人の状態確認を記録する",
          "本人の状態を確認した記録（様子確認）がまだありません。", ["lastChecked"]);
      }
      add("complete", "complete", "対応が終わったら解決を記録する",
        breached("complete") ? "解決の内部対応期限を超過しています。解決の記録には結果・要約・証跡が必要です。" : "解決の記録には結果・要約・証跡が必要です。",
        ["status", "deadline", "evidence"], breached("complete"));
      add("request_handoff", "request_handoff", "勤務を終える前に引継ぎを依頼する",
        "対応中のCaseは、受領されるまで現在の担当者が責任を持ちます。", ["assignee"]);
      break;

    case "HANDOFF_PENDING":
      if (!ownership.handoffTargetUnavailable) {
        add("accept_handoff", "accept_handoff", "引継ぎを受領する",
          breached("handoff_accept") ? "引継ぎ受領の内部対応期限を超過しています。" : "引継ぎ先による受領がまだ記録されていません。", ["handoff", "deadline"], breached("handoff_accept"));
        if (breached("handoff_accept")) {
          add("reassign_unaccepted", "reassign", "引継ぎ先に確認し、応答がなければ担当を変更する",
            "受領の期限を過ぎても引継ぎが受領されていません。", ["handoff", "deadline"], true);
        }
      }
      break;

    case "COMPLETED":
      if (aggregate.escalation) {
        add("clear_escalation_before_close", "clear_escalation", "エスカレーションの対応結果を記録して解除する",
          "エスカレーションが継続中のため、このCaseはまだクローズできません。", ["escalation"], true);
      } else {
        add("close", "close", "内容を確認してクローズする", "解決が記録されています。", ["status"]);
      }
      break;

    case "CLOSED":
      break;
  }

  if (isOpenCaseStatus(aggregate.status) && aggregate.escalation) {
    add("review_escalation", "clear_escalation", "エスカレーションへの対応を確認する（管理者）",
      "エスカレーションが継続中です。対応が済んだら理由を記録して解除してください。", ["escalation"], true);
  }
  if (aggregate.linkedSignalCount > 0 && isOpenCaseStatus(aggregate.status)) {
    add("review_linked_signals", null, "追加で届いた通知の原文を確認する",
      "同じ対象者から追加の通知が紐付いています。内容は「原文・通知記録」で確認できます。", ["linkedSignals"]);
  }
  if (input.pendingDraftCount > 0) {
    add("review_ai_drafts", null, "確認待ちのAI下書きを確認する",
      "AI下書きは職員が承認するまで記録に反映されません。", ["pendingDrafts"]);
  }

  // Operational attention first; otherwise keep the rule order.
  candidates.sort((a, b) => Number(b.attention) - Number(a.attention));

  return {
    generatedBy: ADVISOR_ENGINE,
    disclaimer: ADVISOR_DISCLAIMER,
    situation: situationOf(input),
    candidates,
  };
}
