import type { CaseStatus } from "../core/types.ts";
import type { ConsoleWebAction } from "./types.ts";

/**
 * Presentation only. Never fabricates a permitted Case command:
 * the server-projected capability list remains authoritative.
 */
export function explainCaseStage(status: CaseStatus): string {
  switch (status) {
    case "NEW": return "受付済み・確認待ち";
    case "ACKNOWLEDGED": return "確認済み・担当決定待ち";
    case "ASSIGNED": return "担当決定済み・対応開始待ち";
    case "IN_PROGRESS": return "対応中";
    case "HANDOFF_PENDING": return "引き継ぎ先の受諾待ち";
    case "COMPLETED": return "結果記録済み・終了確認待ち";
    case "CLOSED": return "終了確認済み";
  }
}

export function explainNextStep(
  status: CaseStatus,
  actorId: string | null,
  assigneeId: string | null,
  handoffTargetId: string | null,
  permitted: readonly ConsoleWebAction[],
): string {
  const allowed = new Set(permitted.map((action) => action.type));

  if (status === "HANDOFF_PENDING") {
    if (actorId === handoffTargetId && allowed.has("accept_handoff")) {
      return "引き継ぎ内容を確認し、受諾してください。受諾までは前担当者が責任を持ちます。";
    }
    return "引き継ぎ先の受諾を待っています。受諾までは前担当者が責任を持ちます。";
  }
  if (status === "NEW") {
    return allowed.has("acknowledge")
      ? "内容を確認して、受け付けてください。"
      : "受付内容の確認待ちです。";
  }
  if (status === "ACKNOWLEDGED") {
    return allowed.has("assign")
      ? "対応する担当者を決めてください。"
      : "担当者の割り当て待ちです。";
  }
  if (status === "ASSIGNED") {
    return allowed.has("start_action")
      ? "担当になっています。対応を開始してください。"
      : "担当者が対応を開始するのを待っています。";
  }
  if (status === "IN_PROGRESS") {
    if (actorId === assigneeId && allowed.has("complete")) {
      return "結果と証跡を記録して、対応を完了してください。";
    }
    return "担当者が対応中です。完了結果の確認を待っています。";
  }
  if (status === "COMPLETED") {
    return allowed.has("close")
      ? "完了結果を確認し、Caseを終了してください。"
      : "結果が記録されています。終了確認待ちです。";
  }
  return "対応は終了しています。必要に応じて履歴を確認してください。";
}
