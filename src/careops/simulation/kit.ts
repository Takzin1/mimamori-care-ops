import type { CaseAggregate, CasePriority, CompletionEvidenceItem } from "../../core/types.ts";
import { SIM_FACILITIES, type SimAiMode, type SimWorld } from "./world.ts";

/**
 * Scenario vocabulary for the Simulation Lab. Every scenario is a short
 * script over a SimWorld: staff act through the real platform service,
 * the virtual clock moves, faults are injected, and each expectation is
 * recorded as a check (never thrown), so a report shows exactly which
 * guarantee held or failed.
 */

export const SIM_CATEGORIES = [
  "normal",
  "night",
  "no_response",
  "contact_failure",
  "assignee_unavailable",
  "duplicate_notification",
  "isolation",
  "human_ai",
  "concurrency",
] as const;

export type SimCategory = (typeof SIM_CATEGORIES)[number];

export const SIM_CATEGORY_LABEL: Record<SimCategory, string> = {
  normal: "通常",
  night: "夜間",
  no_response: "未応答",
  contact_failure: "連絡失敗",
  assignee_unavailable: "担当不在",
  duplicate_notification: "多重通知",
  isolation: "施設間データ分離",
  human_ai: "AIと人の承認",
  concurrency: "同時操作",
};

export interface SimScenario {
  id: string;
  category: SimCategory;
  title: string;
  /** The guarantee this scenario demonstrates. */
  verifies: string;
  /** Simulated start (ISO instant). */
  startAt: string;
  ai?: SimAiMode;
  run(world: SimWorld): Promise<void>;
}

export const SAKURA = SIM_FACILITIES.sakura;
export const KAEDE = SIM_FACILITIES.kaede;

/** Synthetic calendar day used by all scenarios (JST). */
export const SIM_DAY = "2026-11-10";
export const SIM_NEXT_DAY = "2026-11-11";

export function jst(time: string, day: string = SIM_DAY): string {
  return new Date(`${day}T${time}:00+09:00`).toISOString();
}

export const visit = (ref: string): CompletionEvidenceItem[] => [{ kind: "visit", ref }];

let subjectCounter = 0;
/** Synthetic resident reference (never a name). */
export function subject(label = "res"): string {
  subjectCounter += 1;
  return `sim-${label}-${String(subjectCounter).padStart(3, "0")}`;
}

export async function openCase(
  world: SimWorld,
  options: { by?: string; priority?: CasePriority; subjectId?: string; facilityId?: string; rawText?: string } = {},
): Promise<CaseAggregate> {
  return world.createCase(options.by ?? "desk", {
    subjectId: options.subjectId ?? subject(),
    priority: options.priority ?? "normal",
    ...(options.facilityId ? { facilityId: options.facilityId } : {}),
    ...(options.rawText ? { rawText: options.rawText } : {}),
  });
}

export async function toAssigned(
  world: SimWorld,
  caseId: string,
  options: { by?: string; assignee?: string; priority?: CasePriority } = {},
): Promise<CaseAggregate> {
  const by = options.by ?? "desk";
  const current = await world.current(caseId);
  await world.cmd(by, caseId, { type: "acknowledge" });
  await world.cmd(by, caseId, {
    type: "triage",
    category: "体調不良",
    priority: options.priority ?? current.priority,
    rationale: "（合成）施設手順に基づく職員判断",
  });
  return world.cmd(by, caseId, { type: "assign", assigneeId: world.actor(options.assignee ?? "r1") });
}

export async function toInProgress(
  world: SimWorld,
  caseId: string,
  options: { by?: string; assignee?: string; priority?: CasePriority } = {},
): Promise<CaseAggregate> {
  await toAssigned(world, caseId, options);
  return world.cmd(options.assignee ?? "r1", caseId, { type: "start_action" });
}

export async function resolve(world: SimWorld, caseId: string, by = "r1", ref = "visit-log:sim-0001"): Promise<CaseAggregate> {
  return world.cmd(by, caseId, {
    type: "complete",
    outcome: "confirmed_safe",
    summary: "（合成）訪問し状態を確認した",
    evidence: visit(ref),
  });
}

export function eventTypes(events: readonly { type: string }[]): string[] {
  return events.map((event) => event.type);
}

/** In-app notifications of one kind visible to a staff member. */
export async function inboxCount(world: SimWorld, key: string, kind: string, caseId?: string): Promise<number> {
  return (await world.inbox(key)).filter((item) => item.kind === kind && (!caseId || item.caseId === caseId)).length;
}
