import { CaseService } from "../application/case-service.ts";
import { InMemoryTenantMembershipDirectory } from "../access/in-memory-membership-directory.ts";
import { calculateCaseMetrics, type CaseMetrics } from "../core/metrics.ts";
import type { CaseEvent, CaseStatus } from "../core/types.ts";
import { InMemoryCaseRepository } from "../persistence/in-memory-case-repository.ts";
import { FrameworkValidationError } from "./errors.ts";
import type { Improvement, PackTrainingTemplate, QuizQuestion, ScenarioActor, ScenarioStep } from "./types.ts";

/**
 * Deterministic training: quiz scoring and scenario drills.
 *
 * A drill replays the trainee's answers through the real Care Ops CaseService on a
 * brand-new in-memory repository in a `training:` tenant on every evaluation. The
 * production repository is never passed in, so a drill Case cannot be stored as a
 * real Case and no notification/outbox path is reachable.
 */
export const TRAINING_TENANT_PREFIX = "training:";

const ACTORS: Record<ScenarioActor, { actorId: string; label: string; roles: ("dispatcher" | "responder" | "supervisor")[] }> = {
  trainee: { actorId: "drill-trainee", label: "あなた", roles: ["responder"] },
  lead: { actorId: "drill-lead", label: "責任者（模擬）", roles: ["dispatcher", "supervisor"] },
  colleague: { actorId: "drill-colleague", label: "交代職員（模擬）", roles: ["responder"] },
};

export interface QuizResultItem {
  questionId: string;
  correct: boolean;
  correctChoiceId: string;
  explanation: string;
  stepRef: string | null;
}

export function publicQuestions(questions: readonly QuizQuestion[]) {
  return questions.map(({ id, prompt, choices }) => ({ id, prompt, choices }));
}

export function scoreQuiz(training: PackTrainingTemplate, answers: Record<string, unknown>) {
  if (training.questions.length === 0) throw new FrameworkValidationError("course has no quiz");
  const results: QuizResultItem[] = [];
  const improvements: Improvement[] = [];
  for (const q of training.questions) {
    const choice = answers[q.id];
    if (typeof choice !== "string" || !q.choices.some((c) => c.id === choice)) {
      throw new FrameworkValidationError("every question needs one valid answer");
    }
    const correct = choice === q.correctChoiceId;
    results.push({ questionId: q.id, correct, correctChoiceId: q.correctChoiceId, explanation: q.explanation, stepRef: q.stepRef });
    if (!correct) {
      improvements.push({
        itemId: q.id,
        prompt: q.prompt,
        correctAction: q.choices.find((c) => c.id === q.correctChoiceId)?.label ?? "",
        explanation: q.explanation,
        stepRef: q.stepRef,
        critical: false,
      });
    }
  }
  const score = Math.round((results.filter((r) => r.correct).length / results.length) * 100);
  return {
    score,
    passed: score >= training.passingScore,
    criticalErrors: 0,
    results,
    improvements,
    answers: Object.fromEntries(training.questions.map((q) => [q.id, answers[q.id] as string])),
  };
}

export interface ScenarioTimelineItem {
  sequence: number;
  at: string;
  type: CaseEvent["type"];
  actor: string;
}

export interface ScenarioEvaluation {
  answered: number;
  total: number;
  feedback: Array<{ stepId: string; correct: boolean; critical: boolean; correctAction: string; explanation: string }>;
  next: { id: string; narrative: string; prompt: string; choices: ScenarioStep["choices"] } | null;
  caseStatus: CaseStatus | null;
  timeline: ScenarioTimelineItem[];
  metrics: CaseMetrics | null;
  summary: null | {
    score: number;
    passed: boolean;
    criticalErrors: number;
    improvements: Improvement[];
  };
}

/** Replays a prefix of scenario answers deterministically through the Case engine. */
export async function evaluateScenario(input: {
  training: PackTrainingTemplate;
  answers: Array<{ stepId: string; choiceId: string }>;
  sessionKey: string;
  clock: () => string;
}): Promise<ScenarioEvaluation> {
  const { training } = input;
  const steps = training.scenario;
  if (steps.length === 0) throw new FrameworkValidationError("course has no scenario");
  if (!Array.isArray(input.answers) || input.answers.length > steps.length) {
    throw new FrameworkValidationError("answers do not match the scenario");
  }
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(input.sessionKey)) throw new FrameworkValidationError("invalid session key");

  const tenantId = `${TRAINING_TENANT_PREFIX}${input.sessionKey}`;
  const caseId = `drill-${input.sessionKey}`;
  const repository = new InMemoryCaseRepository();
  const directory = new InMemoryTenantMembershipDirectory(
    (Object.keys(ACTORS) as ScenarioActor[]).map((key) => ({
      tenantId,
      principalId: `drill:${key}`,
      actorId: ACTORS[key].actorId,
      roles: ACTORS[key].roles,
      active: true,
    })),
  );
  const service = new CaseService(repository, directory, input.clock);

  const feedback: ScenarioEvaluation["feedback"] = [];
  const improvements: Improvement[] = [];
  let criticalErrors = 0;
  for (let i = 0; i < input.answers.length; i++) {
    const step = steps[i]!;
    const answer = input.answers[i]!;
    if (!answer || answer.stepId !== step.id || !step.choices.some((c) => c.id === answer.choiceId)) {
      throw new FrameworkValidationError("answers must follow the scenario order with valid choices");
    }
    const correct = answer.choiceId === step.correctChoiceId;
    const correctAction = step.choices.find((c) => c.id === step.correctChoiceId)?.label ?? "";
    feedback.push({ stepId: step.id, correct, critical: step.critical, correctAction, explanation: step.feedback });
    if (!correct) {
      if (step.critical) criticalErrors++;
      improvements.push({ itemId: step.id, prompt: step.prompt, correctAction, explanation: step.feedback, stepRef: step.stepRef, critical: step.critical });
    }
    // The correct action is applied either way so the drill reaches completion.
    for (const action of step.caseActions) {
      if (action.kind === "open") {
        await service.openFromSignal(
          { id: `${caseId}-signal`, tenantId, sourceAdapter: "framework_training", subjectId: "training-subject", type: "manual", priority: "high" },
          caseId,
        );
        continue;
      }
      const current = await repository.load(tenantId, caseId);
      if (!current) throw new Error("training scenario applied a command before opening its Case");
      await service.execute({
        tenantId,
        caseId,
        principalId: `drill:${action.as}`,
        expectedVersion: current.aggregate.version,
        command: action.command,
      });
    }
  }

  const stored = await repository.load(tenantId, caseId);
  const events = stored?.events ?? [];
  const label = (actorId: string | null) =>
    Object.values(ACTORS).find((a) => a.actorId === actorId)?.label ?? (actorId ? "職員" : "システム");
  const complete = input.answers.length === steps.length;
  const correctCount = feedback.filter((f) => f.correct).length;
  const score = complete ? Math.round((correctCount / steps.length) * 100) : 0;
  const nextStep = complete ? null : steps[input.answers.length]!;
  return {
    answered: input.answers.length,
    total: steps.length,
    feedback,
    next: nextStep ? { id: nextStep.id, narrative: nextStep.narrative, prompt: nextStep.prompt, choices: nextStep.choices } : null,
    caseStatus: stored?.aggregate.status ?? null,
    timeline: events.map((e) => ({ sequence: e.sequence, at: e.at, type: e.type, actor: label(e.actorId) })),
    metrics: events.length ? calculateCaseMetrics(events) : null,
    summary: complete
      ? { score, passed: score >= training.passingScore && criticalErrors === 0, criticalErrors, improvements }
      : null,
  };
}
