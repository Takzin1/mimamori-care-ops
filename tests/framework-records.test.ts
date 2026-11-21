import assert from "node:assert/strict";
import test from "node:test";

import { CaseAccessDeniedError } from "../src/index.ts";
import {
  FrameworkConflictError,
  FrameworkHttpApi,
  FrameworkNotFoundError,
  FrameworkValidationError,
  INDUSTRY_PACKS,
  evaluateScenario,
  recordRoutes,
} from "../src/framework/index.ts";
import { Clock, TokenAuthenticator, provision, world } from "./support/framework-world.ts";

const CARE_FALL = INDUSTRY_PACKS.care.trainings.find((t) => t.key === "fall-response-drill")!;
const correctAnswers = (steps = CARE_FALL.scenario) => steps.map((s) => ({ stepId: s.id, choiceId: s.correctChoiceId }));

test("every sector's scenarios run end to end on the real Case engine in a training tenant", async () => {
  for (const pack of Object.values(INDUSTRY_PACKS)) {
    for (const training of pack.trainings) {
      const clock = new Clock();
      const result = await evaluateScenario({ training, answers: correctAnswers(training.scenario), sessionKey: `s-${training.key}`, clock: clock.tick });
      assert.equal(result.caseStatus, "CLOSED", `${pack.id}/${training.key}`);
      assert.deepEqual(result.timeline.map((t) => t.type), [
        "case_created", "acknowledged", "assigned", "action_started", "handoff_requested", "handoff_accepted", "completed", "closed",
      ]);
      assert.equal(result.summary?.score, 100);
      assert.equal(result.summary?.passed, true);
      assert.equal(result.metrics?.handoffCount, 1);
    }
  }
});

test("scenario: partial replay gives the next step; a critical mistake fails regardless of score", async () => {
  const clock = new Clock();
  const partial = await evaluateScenario({ training: CARE_FALL, answers: correctAnswers().slice(0, 2), sessionKey: "partial", clock: clock.tick });
  assert.equal(partial.summary, null);
  assert.equal(partial.next?.id, CARE_FALL.scenario[2]!.id);
  assert.equal(partial.caseStatus, "ASSIGNED");
  assert.ok(!JSON.stringify(partial.next).includes("correctChoiceId"), "no answer key leaks");

  const answers = correctAnswers().map((a, i) => (i === 0 ? { ...a, choiceId: CARE_FALL.scenario[0]!.choices.find((c) => c.id !== a.choiceId)!.id } : a));
  const failed = await evaluateScenario({ training: CARE_FALL, answers, sessionKey: "critical", clock: clock.tick });
  assert.equal(failed.summary?.score, 83);
  assert.equal(failed.summary?.criticalErrors, 1);
  assert.equal(failed.summary?.passed, false);
  assert.equal(failed.summary?.improvements[0]?.stepRef, "care-fall-1");
  await assert.rejects(
    evaluateScenario({ training: CARE_FALL, answers: [{ stepId: CARE_FALL.scenario[1]!.id, choiceId: "a" }], sessionKey: "order", clock: clock.tick }),
    FrameworkValidationError,
  );
});

test("training is recorded per attempt (pass and fail), pinned to the approved version, and never creates real Cases", async () => {
  const { framework, records, repository } = world();
  await provision(framework);
  const courses = await records.listCourses("p-resp-a", "facility-a");
  assert.deepEqual(courses.map((c) => [c.courseId, c.available, c.manualVersion]), [
    ["care-fall-response-drill", true, 1],
    ["care-shift-handoff-drill", true, 1],
  ]);
  const detail = await records.courseDetail("p-resp-a", "facility-a", "care-fall-response-drill");
  assert.ok(!JSON.stringify(detail.questions).includes("correctChoiceId"));

  const failed = await records.submitQuiz("p-resp-a", "facility-a", "care-fall-response-drill", { attemptId: "quiz-0001", answers: { q1: "a", q2: "b" } });
  assert.equal(failed.recorded, true);
  assert.equal(failed.attempt.passed, false, "failed attempts are recorded too");
  assert.equal(failed.attempt.improvements[0]?.stepRef, "care-fall-1");
  const replay = await records.submitQuiz("p-resp-a", "facility-a", "care-fall-response-drill", { attemptId: "quiz-0001", answers: { q1: "b", q2: "b" } });
  assert.equal(replay.recorded, false);
  assert.equal(replay.attempt.score, failed.attempt.score, "a re-sent attempt keeps the first result");
  await assert.rejects(
    records.submitQuiz("p-resp-a2", "facility-a", "care-fall-response-drill", { attemptId: "quiz-0001", answers: { q1: "b", q2: "b" } }),
    (e: unknown) => e instanceof FrameworkConflictError && e.reason === "training_attempt_exists",
  );

  const drill = await records.scenario("p-resp-a", "facility-a", "care-fall-response-drill", { attemptId: "drill-0001", answers: correctAnswers(), final: true });
  assert.equal(drill.recorded, true);
  assert.equal(drill.attempt?.mode, "scenario");
  assert.equal(drill.attempt?.manualVersion, 1);
  assert.equal(drill.attempt?.simulated, true);
  assert.equal((await repository.list("facility-a")).length, 0, "no real Case from training");

  assert.equal((await records.attempts("p-resp-a", "facility-a", "mine")).length, 2);
  await assert.rejects(records.attempts("p-resp-a", "facility-a", "all"), CaseAccessDeniedError);
  assert.equal((await records.attempts("p-aud-a", "facility-a", "all")).length, 2, "auditors see all records");
  await assert.rejects(records.listCourses("p-resp-a", "school-b"), CaseAccessDeniedError);
});

test("training on a manual without an approved version is refused", async () => {
  const { framework, records } = world();
  await framework.configureTenant("p-sup-a1", "facility-a", { sector: "care", displayName: "A" });
  await framework.installPackTemplates("p-sup-a1", "facility-a");
  const courses = await records.listCourses("p-resp-a", "facility-a");
  assert.ok(courses.every((c) => !c.available));
  await assert.rejects(
    records.submitQuiz("p-resp-a", "facility-a", "care-fall-response-drill", { attemptId: "quiz-0002", answers: { q1: "b", q2: "b" } }),
    (e: unknown) => e instanceof FrameworkConflictError && e.reason === "manual_not_field_visible",
  );
});

test("step checks and evidence bundle connect manual version, actions, handoff, completion and training", async () => {
  const { framework, records, caseService } = world();
  await provision(framework);
  await records.submitQuiz("p-resp-a", "facility-a", "care-fall-response-drill", { attemptId: "quiz-0003", answers: { q1: "b", q2: "b" } });
  const opened = await framework.openCaseFromManual("p-resp-a", "facility-a", { manualId: "care-fall-response", manualVersion: 1, signalId: "sig-ev", subjectRef: "2F-203" });
  const caseId = opened.aggregate.id;
  let v = opened.aggregate.version;
  const run = async (principalId: string, command: Parameters<typeof caseService.execute>[0]["command"]) => {
    v = (await caseService.execute({ tenantId: "facility-a", caseId, principalId, expectedVersion: v, command })).aggregate.version;
  };

  await assert.rejects(records.checkStep("p-resp-a", "facility-a", caseId, "care-fall-1"), CaseAccessDeniedError, "responder sees only assigned Cases");
  await run("p-disp-a", { type: "acknowledge" });
  await run("p-disp-a", { type: "assign", assigneeId: "resp-a" });
  await run("p-resp-a", { type: "start_action" });
  assert.equal((await records.checkStep("p-resp-a", "facility-a", caseId, "care-fall-1")).created, true);
  assert.equal((await records.checkStep("p-resp-a", "facility-a", caseId, "care-fall-1")).created, false, "idempotent");
  await records.checkStep("p-resp-a", "facility-a", caseId, "care-fall-2");
  await assert.rejects(records.checkStep("p-resp-a", "facility-a", caseId, "not-a-step"), FrameworkValidationError);
  await assert.rejects(records.checkStep("p-aud-a", "facility-a", caseId, "care-fall-3"), CaseAccessDeniedError);
  await run("p-resp-a", { type: "request_handoff", targetAssigneeId: "resp-a2" });
  await run("p-resp-a2", { type: "accept_handoff" });
  await records.checkStep("p-resp-a2", "facility-a", caseId, "care-fall-3");
  await run("p-resp-a2", { type: "complete", outcome: "other", summary: "合成データ", evidence: [{ kind: "note", ref: "rec-1" }] });
  await assert.rejects(
    records.checkStep("p-resp-a2", "facility-a", caseId, "care-fall-4"),
    (e: unknown) => e instanceof FrameworkConflictError && e.reason === "case_closed",
  );

  const evidence = await records.evidence("p-sup-a1", "facility-a", caseId);
  assert.equal(evidence.schema, "mimamori.framework.evidence.v1");
  assert.equal(evidence.manual?.manualId, "care-fall-response");
  assert.equal(evidence.manual?.version, 1);
  assert.equal(evidence.manual?.approvedBy, "sup-a2");
  assert.deepEqual(evidence.steps?.checked.map((c) => [c.stepId, c.checkedBy]), [["care-fall-1", "resp-a"], ["care-fall-2", "resp-a"], ["care-fall-3", "resp-a2"]]);
  assert.deepEqual(evidence.steps?.uncheckedCritical, []);
  assert.deepEqual(evidence.handoffs.map((h) => [h.from, h.to, h.acceptedBy]), [["resp-a", "resp-a2", "resp-a2"]]);
  assert.equal(evidence.completion?.evidence[0]?.ref, "rec-1");
  assert.deepEqual(evidence.training.map((t) => [t.actorId, t.passed, t.manualVersion]), [["resp-a", true, 1]]);
  assert.equal(evidence.metrics.handoffCount, 1);
  await assert.rejects(records.evidence("p-resp-b", "school-b", caseId), FrameworkNotFoundError, "other tenants cannot address the Case");
});

test("HTTP: training and evidence routes share the authenticated boundary", async () => {
  const { framework, records } = world();
  await provision(framework);
  const api = new FrameworkHttpApi({ authenticator: new TokenAuthenticator(), service: framework, extraRoutes: [recordRoutes(records)] });
  const call = (method: string, path: string, token: string, body?: unknown) =>
    api.handle(new Request(`https://framework.test/api/framework/tenants/facility-a${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));
  assert.equal((await call("GET", "/training/courses", "tok-resp-a")).status, 200);
  const quiz = await call("POST", "/training/courses/care-fall-response-drill/quiz", "tok-resp-a", { attemptId: "http-quiz-01", answers: { q1: "b", q2: "b" } });
  assert.equal(quiz.status, 201);
  assert.equal((await call("POST", "/training/courses/care-fall-response-drill/quiz", "tok-resp-a", { attemptId: "http-quiz-01", answers: { q1: "b", q2: "b" } })).status, 200);
  const partial = await call("POST", "/training/courses/care-fall-response-drill/scenario", "tok-resp-a", { attemptId: "http-drill-01", answers: correctAnswers().slice(0, 1) });
  assert.equal(partial.status, 200);
  const final = await call("POST", "/training/courses/care-fall-response-drill/scenario", "tok-resp-a", { attemptId: "http-drill-01", answers: correctAnswers(), final: true });
  assert.equal(final.status, 201);
  assert.equal((await call("GET", "/training/attempts?scope=all", "tok-resp-a")).status, 403);
  assert.equal((await call("GET", "/training/attempts?scope=all", "tok-sup-a1")).status, 200);
  assert.equal((await call("GET", "/cases/nope/evidence", "tok-sup-a1")).status, 404);
  assert.equal((await call("POST", "/training/courses/unknown/quiz", "tok-resp-a", { attemptId: "http-quiz-02", answers: {} })).status, 404);
});
