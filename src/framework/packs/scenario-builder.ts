import type { QuizChoice, ScenarioStep } from "../types.ts";

/**
 * Builds the standard response drill shared by every sector:
 *   first action → report (Case opened, lead acknowledges & assigns trainee)
 *   → start → record → handoff (colleague accepts) → completion (evidence) → close.
 * The Case transitions themselves are executed by the real Care Ops CaseService
 * in an isolated training tenant; this builder only supplies sector wording.
 */
export interface StandardScenarioText {
  prefix: string;
  first: { narrative: string; prompt: string; right: string; wrong: string[]; feedback: string; stepRef: string };
  report: { narrative: string; right: string; wrong: string; feedback: string; stepRef: string };
  start: { narrative: string; right: string; wrong: string; feedback: string; stepRef: string };
  record: { right: string; wrong: string; feedback: string; stepRef: string };
  handoff: { narrative: string; feedback: string; stepRef: string };
  completion: { narrative: string; summary: string; evidenceRef: string; stepRef: string };
}

function choices(right: string, wrong: string[], rightPosition: number): { choices: QuizChoice[]; correct: string } {
  const labels = [...wrong];
  labels.splice(rightPosition, 0, right);
  const ids = ["a", "b", "c", "d"];
  return {
    choices: labels.map((label, i) => ({ id: ids[i]!, label })),
    correct: ids[rightPosition]!,
  };
}

export function standardScenario(t: StandardScenarioText): ScenarioStep[] {
  const first = choices(t.first.right, t.first.wrong, 1);
  const report = choices(t.report.right, [t.report.wrong], 0);
  const start = choices(t.start.right, [t.start.wrong], 0);
  const record = choices(t.record.right, [t.record.wrong], 0);
  const handoff = choices(
    "引き継ぎを依頼し、相手が受諾するまで自分が担当を続ける",
    ["記録に書き残して、そのまま交代する"],
    1,
  );
  const completion = choices(
    "結果・要約・証跡（記録の場所など）がそろったとき",
    ["対応を始めた時点ですぐ"],
    1,
  );
  return [
    {
      id: `${t.prefix}-first`,
      narrative: t.first.narrative,
      prompt: t.first.prompt,
      choices: first.choices,
      correctChoiceId: first.correct,
      critical: true,
      stepRef: t.first.stepRef,
      feedback: t.first.feedback,
      caseActions: [],
    },
    {
      id: `${t.prefix}-report`,
      narrative: t.report.narrative,
      prompt: "報告の方法として適切なのは？",
      choices: report.choices,
      correctChoiceId: report.correct,
      critical: true,
      stepRef: t.report.stepRef,
      feedback: t.report.feedback,
      caseActions: [
        { kind: "open" },
        { kind: "command", as: "lead", command: { type: "acknowledge" } },
        { kind: "command", as: "lead", command: { type: "assign", assigneeId: "drill-trainee" } },
      ],
    },
    {
      id: `${t.prefix}-start`,
      narrative: t.start.narrative,
      prompt: "次に行うことは？",
      choices: start.choices,
      correctChoiceId: start.correct,
      critical: false,
      stepRef: t.start.stepRef,
      feedback: t.start.feedback,
      caseActions: [{ kind: "command", as: "trainee", command: { type: "start_action" } }],
    },
    {
      id: `${t.prefix}-record`,
      narrative: "落ち着いたところで記録を残します。",
      prompt: "記録に残す内容として適切なのは？",
      choices: record.choices,
      correctChoiceId: record.correct,
      critical: false,
      stepRef: t.record.stepRef,
      feedback: t.record.feedback,
      caseActions: [],
    },
    {
      id: `${t.prefix}-handoff`,
      narrative: t.handoff.narrative,
      prompt: "対応中の案件をどう引き継ぎますか？",
      choices: handoff.choices,
      correctChoiceId: handoff.correct,
      critical: false,
      stepRef: t.handoff.stepRef,
      feedback: t.handoff.feedback,
      caseActions: [
        { kind: "command", as: "trainee", command: { type: "request_handoff", targetAssigneeId: "drill-colleague" } },
        { kind: "command", as: "colleague", command: { type: "accept_handoff" } },
      ],
    },
    {
      id: `${t.prefix}-completion`,
      narrative: t.completion.narrative,
      prompt: "「対応完了」にできるのはどんなときですか？",
      choices: completion.choices,
      correctChoiceId: completion.correct,
      critical: false,
      stepRef: t.completion.stepRef,
      feedback: "完了には結果・要約・証跡が必要です。状態だけの完了はできません。",
      caseActions: [
        {
          kind: "command",
          as: "colleague",
          command: {
            type: "complete",
            outcome: "other",
            summary: t.completion.summary,
            evidence: [{ kind: "note", ref: t.completion.evidenceRef }],
          },
        },
        { kind: "command", as: "lead", command: { type: "close" } },
      ],
    },
  ];
}
