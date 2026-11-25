import type { CaseService } from "../application/case-service.ts";
import type { TenantMembership, TenantMembershipDirectory } from "../access/types.ts";
import { calculateCaseMetrics } from "../core/metrics.ts";
import { FrameworkConflictError, FrameworkNotFoundError, FrameworkValidationError } from "./errors.ts";
import { isFieldVisible } from "./manual-rules.ts";
import { industryPack } from "./packs/index.ts";
import { assertFrameworkPermission, boundMembership, hasFrameworkPermission } from "./policy.ts";
import type { FrameworkStore } from "./store/types.ts";
import { evaluateScenario, publicQuestions, scoreQuiz } from "./training-engine.ts";
import type {
  FrameworkManualVersion,
  IndustryPack,
  PackTrainingTemplate,
  TrainingAttempt,
} from "./types.ts";

const ATTEMPT_ID = /^[A-Za-z0-9-]{8,64}$/;
const STEP_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

export interface FrameworkRecordsServiceOptions {
  store: FrameworkStore;
  memberships: TenantMembershipDirectory;
  caseService: CaseService;
  now?: () => string;
}

interface ResolvedCourse {
  pack: IndustryPack;
  training: PackTrainingTemplate;
  courseId: string;
  manualId: string;
  version: FrameworkManualVersion | null;
}

/**
 * Training, step checks and evidence (P2). Training is bound to the manual's
 * currently approved version and never touches the production Case repository;
 * step checks and evidence read Cases only through CaseService (visibility rules apply).
 */
export class FrameworkRecordsService {
  private readonly store: FrameworkStore;
  private readonly memberships: TenantMembershipDirectory;
  private readonly caseService: CaseService;
  private readonly now: () => string;

  constructor(options: FrameworkRecordsServiceOptions) {
    this.store = options.store;
    this.memberships = options.memberships;
    this.caseService = options.caseService;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private async member(tenantId: string, principalId: string, permission: Parameters<typeof assertFrameworkPermission>[1]): Promise<TenantMembership> {
    const membership = boundMembership(await this.memberships.findByPrincipal(tenantId, principalId), tenantId, principalId);
    assertFrameworkPermission(membership, permission);
    return membership;
  }

  private async resolveCourses(tenantId: string): Promise<ResolvedCourse[]> {
    const profile = await this.store.getTenantProfile(tenantId);
    if (!profile) throw new FrameworkNotFoundError("Tenant is not configured for the Framework");
    const pack = industryPack(profile.sector);
    const now = this.now();
    return Promise.all(pack.trainings.map(async (training) => {
      const manualId = `${pack.id}-${training.manualKey}`;
      const versions = await this.store.listVersions(tenantId, manualId);
      return {
        pack,
        training,
        courseId: `${pack.id}-${training.key}`,
        manualId,
        version: versions.find((v) => isFieldVisible(v, now)) ?? null,
      };
    }));
  }

  private async course(tenantId: string, courseId: string): Promise<ResolvedCourse> {
    const found = (await this.resolveCourses(tenantId)).find((c) => c.courseId === courseId);
    if (!found) throw new FrameworkNotFoundError("Course not found");
    return found;
  }

  // ── Training Engine ──────────────────────────────────────────────

  async listCourses(principalId: string, tenantId: string) {
    const membership = await this.member(tenantId, principalId, "take_training");
    const [courses, mine] = await Promise.all([
      this.resolveCourses(tenantId),
      this.store.listTrainingAttempts(tenantId, { actorIds: [membership.actorId], limit: 200 }),
    ]);
    return courses.map((c) => ({
      courseId: c.courseId,
      title: c.training.title,
      minutes: c.training.minutes,
      passingScore: c.training.passingScore,
      manualId: c.manualId,
      manualVersion: c.version?.version ?? null,
      available: c.version !== null,
      questionCount: c.training.questions.length,
      scenarioSteps: c.training.scenario.length,
      latest: {
        quiz: mine.find((a) => a.courseId === c.courseId && a.mode === "quiz") ?? null,
        scenario: mine.find((a) => a.courseId === c.courseId && a.mode === "scenario") ?? null,
      },
    }));
  }

  async courseDetail(principalId: string, tenantId: string, courseId: string) {
    await this.member(tenantId, principalId, "take_training");
    const c = await this.course(tenantId, courseId);
    if (!c.version) throw new FrameworkConflictError("manual_not_field_visible");
    const first = c.training.scenario[0];
    return {
      courseId: c.courseId,
      title: c.training.title,
      minutes: c.training.minutes,
      passingScore: c.training.passingScore,
      manual: { manualId: c.manualId, version: c.version.version, steps: c.version.steps, fictionalTemplate: c.version.fictionalTemplate },
      questions: publicQuestions(c.training.questions),
      scenario: first ? { steps: c.training.scenario.length, first: { id: first.id, narrative: first.narrative, prompt: first.prompt, choices: first.choices } } : null,
      disclaimer: c.pack.disclaimer,
    };
  }

  private attemptId(value: unknown): string {
    if (typeof value !== "string" || !ATTEMPT_ID.test(value)) throw new FrameworkValidationError("attemptId must be 8-64 [A-Za-z0-9-] characters");
    return value;
  }

  async submitQuiz(principalId: string, tenantId: string, courseId: string, input: { attemptId: unknown; answers: unknown }) {
    const membership = await this.member(tenantId, principalId, "take_training");
    const attemptId = this.attemptId(input.attemptId);
    if (!input.answers || typeof input.answers !== "object" || Array.isArray(input.answers)) {
      throw new FrameworkValidationError("answers must be an object");
    }
    const c = await this.course(tenantId, courseId);
    if (!c.version) throw new FrameworkConflictError("manual_not_field_visible");
    const scored = scoreQuiz(c.training, input.answers as Record<string, unknown>);
    const recorded = await this.store.recordTrainingAttempt({
      tenantId,
      attemptId,
      courseId,
      manualId: c.manualId,
      manualVersion: c.version.version,
      actorId: membership.actorId,
      mode: "quiz",
      score: scored.score,
      passed: scored.passed,
      criticalErrors: 0,
      answers: scored.answers,
      improvements: scored.improvements,
      metrics: null,
      completedAt: this.now(),
      simulated: true,
    });
    return { recorded: recorded.created, attempt: recorded.attempt, results: scored.results };
  }

  /** Stateless replay; records the attempt once when `final` and the scenario is complete. */
  async scenario(
    principalId: string,
    tenantId: string,
    courseId: string,
    input: { attemptId: unknown; answers: unknown; final?: unknown },
  ) {
    const membership = await this.member(tenantId, principalId, "take_training");
    const attemptId = this.attemptId(input.attemptId);
    if (!Array.isArray(input.answers)) throw new FrameworkValidationError("answers must be an array");
    const c = await this.course(tenantId, courseId);
    if (!c.version) throw new FrameworkConflictError("manual_not_field_visible");
    const evaluation = await evaluateScenario({
      training: c.training,
      answers: input.answers as Array<{ stepId: string; choiceId: string }>,
      sessionKey: attemptId,
      clock: this.now,
    });
    let attempt: TrainingAttempt | null = null;
    let recorded = false;
    if (input.final === true) {
      if (!evaluation.summary) throw new FrameworkValidationError("scenario is not complete");
      const result = await this.store.recordTrainingAttempt({
        tenantId,
        attemptId,
        courseId,
        manualId: c.manualId,
        manualVersion: c.version.version,
        actorId: membership.actorId,
        mode: "scenario",
        score: evaluation.summary.score,
        passed: evaluation.summary.passed,
        criticalErrors: evaluation.summary.criticalErrors,
        answers: Object.fromEntries((input.answers as Array<{ stepId: string; choiceId: string }>).map((a) => [a.stepId, a.choiceId])),
        improvements: evaluation.summary.improvements,
        metrics: evaluation.metrics,
        completedAt: this.now(),
        simulated: true,
      });
      attempt = result.attempt;
      recorded = result.created;
    }
    return { ...evaluation, attempt, recorded };
  }

  async attempts(principalId: string, tenantId: string, scope: unknown) {
    const membership = await this.member(tenantId, principalId, "take_training");
    if (scope === "all") {
      if (!hasFrameworkPermission(membership, "view_training_records")) {
        await this.member(tenantId, principalId, "view_training_records");
      }
      return this.store.listTrainingAttempts(tenantId, { limit: 500 });
    }
    return this.store.listTrainingAttempts(tenantId, { actorIds: [membership.actorId], limit: 200 });
  }

  // ── Response Engine: step checks ──────────────────────────────────

  private async linkedCase(principalId: string, tenantId: string, caseId: string) {
    const stored = await this.caseService.get({ tenantId, caseId, principalId });
    if (!stored) throw new FrameworkNotFoundError("Case not found");
    const link = await this.store.getCaseLink(tenantId, caseId);
    const version = link ? await this.store.getVersion(tenantId, link.manualId, link.manualVersion) : null;
    return { stored, link, version };
  }

  async listStepChecks(principalId: string, tenantId: string, caseId: string) {
    await this.member(tenantId, principalId, "read_manuals");
    const { link, version } = await this.linkedCase(principalId, tenantId, caseId);
    if (!link || !version) return { steps: [], checks: [] };
    return { steps: version.steps, checks: await this.store.listStepChecks(tenantId, caseId) };
  }

  async checkStep(principalId: string, tenantId: string, caseId: string, stepId: unknown) {
    const membership = await this.member(tenantId, principalId, "record_steps");
    if (typeof stepId !== "string" || !STEP_ID.test(stepId)) throw new FrameworkValidationError("stepId is invalid");
    const { stored, link, version } = await this.linkedCase(principalId, tenantId, caseId);
    if (!link || !version) throw new FrameworkNotFoundError("Case was not opened from a manual");
    if (stored.aggregate.status === "COMPLETED" || stored.aggregate.status === "CLOSED") {
      throw new FrameworkConflictError("case_closed");
    }
    if (!version.steps.some((s) => s.id === stepId)) throw new FrameworkValidationError("stepId is not part of the linked manual version");
    return this.store.recordStepCheck({ tenantId, caseId, stepId, checkedBy: membership.actorId, checkedAt: this.now() });
  }

  // ── Evidence Engine ──────────────────────────────────────────────

  /**
   * One exportable record per Case: manual version used, step checks, the Case
   * event history (assignment, handoffs, completion evidence), training records of
   * the staff involved for that manual, and Case metrics. Derived, not duplicated:
   * Case facts come from the Case engine, Framework facts from the Framework store.
   */
  async evidence(principalId: string, tenantId: string, caseId: string) {
    await this.member(tenantId, principalId, "read_manuals");
    const { stored, link, version } = await this.linkedCase(principalId, tenantId, caseId);
    const manual = link ? await this.store.getManual(tenantId, link.manualId) : null;
    const events = stored.events;
    const actors = [...new Set(events.map((e) => e.actorId).filter((a): a is string => Boolean(a)))];
    const checks = link ? await this.store.listStepChecks(tenantId, caseId) : [];
    const training = link && actors.length
      ? await this.store.listTrainingAttempts(tenantId, { actorIds: actors, manualId: link.manualId, limit: 100 })
      : [];
    const handoffs = events.flatMap((e, i) => {
      if (e.type !== "handoff_requested") return [];
      const accepted = events.slice(i + 1).find((n) => n.type === "handoff_accepted");
      return [{
        from: e.actorId,
        to: e.data.targetAssigneeId,
        requestedAt: e.at,
        acceptedAt: accepted?.at ?? null,
        acceptedBy: accepted?.actorId ?? null,
      }];
    });
    const checkedIds = new Set(checks.map((c) => c.stepId));
    const a = stored.aggregate;
    return {
      schema: "mimamori.framework.evidence.v1",
      generatedAt: this.now(),
      case: {
        caseId: a.id,
        status: a.status,
        priority: a.priority,
        subjectId: a.subjectId,
        version: a.version,
        assigneeId: a.assigneeId,
        createdAt: a.createdAt,
        completedAt: a.completedAt,
        closedAt: a.closedAt,
      },
      manual: link && version && manual
        ? {
            manualId: link.manualId,
            title: manual.title,
            version: version.version,
            status: version.status,
            approvedBy: version.reviewedBy,
            approvedAt: version.reviewedAt,
            fictionalTemplate: version.fictionalTemplate,
            linkedBy: link.linkedBy,
            linkedAt: link.linkedAt,
          }
        : null,
      steps: version
        ? {
            total: version.steps.length,
            checked: checks,
            uncheckedCritical: version.steps.filter((s) => s.critical && !checkedIds.has(s.id)).map((s) => s.id),
          }
        : null,
      timeline: events.map((e) => ({ sequence: e.sequence, type: e.type, at: e.at, actorId: e.actorId })),
      handoffs,
      completion: a.completion,
      training: training.map((t) => ({
        actorId: t.actorId,
        courseId: t.courseId,
        mode: t.mode,
        manualVersion: t.manualVersion,
        passed: t.passed,
        completedAt: t.completedAt,
        simulated: t.simulated,
      })),
      metrics: calculateCaseMetrics(events),
    };
  }
}
