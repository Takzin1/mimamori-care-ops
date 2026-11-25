import type { CaseCommandType, CaseEvent, CasePriority, CaseStatus, CompletionOutcome, EvidenceKind } from "../../core/types.ts";
import type { FrameworkSector } from "../types.ts";
import type { FailureKind, FrameworkClientError } from "./client.ts";

/** Plain-language wording for field staff. Presentation only — no business rules. */
export const HOME_WORDING: Record<FrameworkSector, { start: string; active: string; noun: string }> = {
  care: { start: "対応を開始する", active: "対応中のケースを確認する", noun: "ケース" },
  education: { start: "事案対応を開始する", active: "対応中の事案を確認する", noun: "事案" },
  healthcare: { start: "案件対応を開始する", active: "対応中の案件を確認する", noun: "案件" },
  public: { start: "対応を開始する", active: "対応中のタスクを確認する", noun: "タスク" },
};

export const STATUS_LABEL: Record<CaseStatus, string> = {
  NEW: "受付待ち",
  ACKNOWLEDGED: "受付済み（担当未定）",
  ASSIGNED: "担当決定",
  IN_PROGRESS: "対応中",
  HANDOFF_PENDING: "引き継ぎ待ち",
  COMPLETED: "完了報告済み",
  CLOSED: "終了",
};

export const COMMAND_LABEL: Record<CaseCommandType, string> = {
  set_priority: "優先度を変更する",
  acknowledge: "受け付ける",
  assign: "担当を割り当てる",
  start_action: "対応を始める",
  request_handoff: "引き継ぎを依頼する",
  accept_handoff: "引き継ぎを受ける",
  complete: "完了を報告する",
  close: "終了を確認する",
  reopen: "再開する",
};

export const EVENT_LABEL: Record<CaseEvent["type"], string> = {
  case_created: "開始（報告）",
  priority_changed: "優先度の変更",
  acknowledged: "受付",
  assigned: "担当の割り当て",
  action_started: "対応開始",
  handoff_requested: "引き継ぎ依頼",
  handoff_accepted: "引き継ぎ受諾",
  completed: "完了報告",
  closed: "終了確認",
  reopened: "再開",
};

export const PRIORITY_LABEL: Record<CasePriority, string> = {
  critical: "緊急",
  high: "高",
  normal: "通常",
  low: "低",
};

export const OUTCOME_LABEL: Record<CompletionOutcome, string> = {
  confirmed_safe: "安全を確認した",
  family_confirmed: "家族・関係者に確認した",
  visit_completed: "現地で確認した",
  support_connected: "支援・担当部署につないだ",
  supplies_delivered: "物資を届けた",
  emergency_handoff_completed: "救急・専門機関へ引き継いだ",
  false_alarm: "誤報だった",
  declined: "対象者が支援を辞退した",
  other: "その他",
};

export const EVIDENCE_LABEL: Record<EvidenceKind, string> = {
  note: "記録メモ",
  call: "電話",
  visit: "現地確認",
  message: "メッセージ",
  external_ref: "他システムの記録番号",
};

const FAILURE_TEXT: Record<FailureKind, string> = {
  network: "通信できませんでした。電波の良い場所で、もう一度お試しください。",
  unauthenticated: "ログインの有効期限が切れました。画面を開き直してください。",
  forbidden: "この操作を行う権限がありません。必要な場合は責任者に依頼してください。",
  not_found: "見つかりませんでした。削除されたか、閲覧する権限がありません。",
  conflict: "ほかの人が先に更新しました。最新の状態を確認してから操作してください。",
  invalid_transition: "現在の状態では、この操作はできません。最新の状態を確認してください。",
  invalid_input: "入力内容を確認してください。",
  unavailable: "サービスが一時的に利用できません。少し待ってから、もう一度お試しください。",
  unknown: "予期しないエラーが発生しました。",
};

const CONFLICT_REASON_TEXT: Record<string, string> = {
  case_version: "ほかの人が先にこのケースを更新しました。最新の状態を表示します。内容を確認してから、もう一度操作してください。",
  manual_version_stale: "手順が改訂されたため、この版では開始できません。最新の手順を開き直してください。",
  manual_not_field_visible: "承認済みの手順がないため、利用できません。",
  case_closed: "完了・終了したため、手順チェックは変更できません。",
  case_link_mismatch: "同じ報告番号で別の内容がすでに登録されています。画面を開き直して、新しく開始してください。",
  training_attempt_exists: "この研修結果はすでに記録されています。",
  step_check_exists: "この手順はすでにチェック済みです。",
};

/** User-facing message for a failure. Writes are always reported as "not saved". */
export function failureMessage(error: FrameworkClientError, write: boolean): string {
  const base = (error.kind === "conflict" && error.reason && CONFLICT_REASON_TEXT[error.reason]) || FAILURE_TEXT[error.kind];
  if (!write) return base;
  if (error.kind === "conflict" || error.kind === "invalid_transition") return `保存されていません。${base}`;
  if (error.kind === "network" || error.kind === "unavailable" || error.kind === "unknown") {
    return `保存できたか確認できません。${base} 同じ画面から再度操作すると、二重に登録されないよう同じ番号で送信します。`;
  }
  return `保存されていません。${base}`;
}

export const SAFETY_NOTE =
  "このアプリは安全確保の唯一の手段ではありません。緊急時は、施設・組織の通常の連絡手段（内線・電話・119番/110番など）で直ちに対応してください。";
