import assert from "node:assert/strict";
import test from "node:test";
import { INDUSTRY_PACKS } from "../src/framework/packs/index.ts";
import { FRAMEWORK_SECTORS } from "../src/framework/types.ts";
import { classifyFailure, FrameworkClientError } from "../src/framework/ui/client.ts";
import { HttpFrameworkClient } from "../src/framework/ui/http-client.ts";
import { failureMessage, HOME_WORDING } from "../src/framework/ui/labels.ts";
import { LocalDemoClient } from "../src/framework/ui/local-client.ts";

function clock(start = "2026-11-25T09:00:00.000Z") {
  let t = Date.parse(start);
  return () => new Date((t += 1000)).toISOString();
}

const kind = (expected: string, reason?: string) => (error: unknown) => {
  const failure = classifyFailure(error);
  assert.equal(failure.kind, expected);
  if (reason !== undefined) assert.equal(failure.reason, reason);
  return true;
};

test("demo client: manual → Case → handoff → completion → evidence through the real engine", async () => {
  const client = new LocalDemoClient(clock());
  await client.setSector("care");

  const hits = await client.search("転倒 記録", null);
  assert.deepEqual(hits.map((h) => h.manualId), ["care-fall-response"]);
  assert.ok(hits.every((h) => h.fictionalTemplate), "demo templates are marked fictional");
  const { version } = await client.manual("care-fall-response");
  assert.equal(version.status, "approved");
  assert.notEqual(version.createdBy, version.reviewedBy, "demo approval still uses four-eyes");

  // Staff (responder) reports; Care Ops RBAC hides unassigned Cases from responders.
  const opened = await client.openCase({ manualId: "care-fall-response", manualVersion: version.version, signalId: "fw-test-0001", subjectRef: "2F-203" });
  assert.equal(opened.created, true);
  await assert.rejects(client.caseDetail(opened.caseId), kind("forbidden"));
  const replay = await client.openCase({ manualId: "care-fall-response", manualVersion: version.version, signalId: "fw-test-0001", subjectRef: "2F-203" });
  assert.deepEqual(replay, { caseId: opened.caseId, created: false }, "explicit retry with the same key does not duplicate");

  client.setPersona("lead");
  let detail = await client.caseDetail(opened.caseId);
  assert.equal(detail.stored.aggregate.status, "NEW");
  assert.deepEqual(detail.capabilities.commands.map((c) => c.type).sort(), ["acknowledge", "set_priority"]);
  await client.execute(opened.caseId, detail.stored.aggregate.version, { type: "acknowledge" });
  await assert.rejects(
    client.execute(opened.caseId, detail.stored.aggregate.version, { type: "acknowledge" }),
    kind("conflict", "case_version"),
    "stale expectedVersion is rejected, never applied twice",
  );
  detail = await client.caseDetail(opened.caseId);
  await client.execute(opened.caseId, detail.stored.aggregate.version, { type: "assign", assigneeId: "demo-staff" });
  await client.checkStep(opened.caseId, "care-fall-1");

  client.setPersona("staff");
  detail = await client.caseDetail(opened.caseId);
  assert.deepEqual(detail.capabilities.commands.map((c) => c.type), ["start_action"]);
  await client.execute(opened.caseId, detail.stored.aggregate.version, { type: "start_action" });
  await client.checkStep(opened.caseId, "care-fall-2");
  await assert.rejects(client.checkStep(opened.caseId, "not-a-step"), kind("invalid_input"));
  detail = await client.caseDetail(opened.caseId);
  await assert.rejects(
    client.execute(opened.caseId, detail.stored.aggregate.version, { type: "close" }),
    kind("forbidden"),
    "a responder cannot close",
  );
  await client.execute(opened.caseId, detail.stored.aggregate.version, { type: "request_handoff", targetAssigneeId: "demo-colleague" });

  client.setPersona("colleague");
  detail = await client.caseDetail(opened.caseId);
  await client.execute(opened.caseId, detail.stored.aggregate.version, { type: "accept_handoff" });
  detail = await client.caseDetail(opened.caseId);
  await client.execute(opened.caseId, detail.stored.aggregate.version, {
    type: "complete",
    outcome: "confirmed_safe",
    summary: "けががないことを確認（架空）",
    evidence: [{ kind: "note", ref: "demo-note-1" }],
  });
  await assert.rejects(client.checkStep(opened.caseId, "care-fall-3"), kind("conflict", "case_closed"));

  client.setPersona("lead");
  detail = await client.caseDetail(opened.caseId);
  await client.execute(opened.caseId, detail.stored.aggregate.version, { type: "close" });

  const evidence = (await client.evidence(opened.caseId)) as {
    schema: string;
    case: { status: string };
    manual: { version: number; fictionalTemplate: boolean };
    handoffs: Array<{ from: string; to: string; acceptedBy: string }>;
  };
  assert.equal(evidence.schema, "mimamori.framework.evidence.v1");
  assert.equal(evidence.case.status, "CLOSED");
  assert.equal(evidence.manual.fictionalTemplate, true);
  assert.deepEqual(evidence.handoffs.map((h) => [h.from, h.to, h.acceptedBy]), [["demo-staff", "demo-colleague", "demo-colleague"]]);

  // History respects visibility: the lead sees it, the original reporter (no longer involved) does not.
  assert.equal((await client.caseHistory()).length, 1);
  client.setPersona("staff");
  assert.equal((await client.caseHistory()).length, 0);

  client.setPersona("lead");
  const exported = (await client.exportAll()) as { synthetic: boolean; cases: unknown[] };
  assert.equal(exported.synthetic, true);
  assert.equal(exported.cases.length, 0, "the active queue export excludes closed Cases");
});

test("demo client: training is recorded but never creates Cases in the demo tenant", async () => {
  const client = new LocalDemoClient(clock());
  await client.setSector("education");
  const courses = await client.courses();
  assert.equal(courses.length, 2);
  assert.ok(courses.every((c) => c.available));

  const pack = INDUSTRY_PACKS.education;
  const training = pack.trainings[0]!;
  const courseId = `${pack.id}-${training.key}`;
  const course = await client.course(courseId);
  assert.ok(course.questions.every((q) => !("correctChoiceId" in q)), "answers are not exposed to the client");

  const answers = Object.fromEntries(training.questions.map((q) => [q.id, q.correctChoiceId]));
  const quiz = await client.submitQuiz(courseId, "quiz-test-0001", answers);
  assert.equal(quiz.recorded, true);
  assert.equal(quiz.attempt.passed, true);
  assert.equal((await client.submitQuiz(courseId, "quiz-test-0001", answers)).recorded, false);

  const steps = training.scenario.map((s) => ({ stepId: s.id, choiceId: s.correctChoiceId }));
  const partial = await client.scenario(courseId, "drill-test-0001", steps.slice(0, 2), false);
  assert.equal(partial.recorded, false);
  assert.ok(partial.next);
  const done = await client.scenario(courseId, "drill-test-0001", steps, true);
  assert.equal(done.recorded, true);
  assert.equal(done.summary?.passed, true);
  assert.equal(done.attempt?.simulated, true);
  assert.equal(done.caseStatus, "CLOSED");

  client.setPersona("lead");
  const queue = await client.cases();
  assert.equal(queue.items.length, 0, "drill Cases stay in their isolated training tenant");
  assert.equal((await client.attempts()).length, 0, "attempts are per person");
  client.setPersona("staff");
  assert.equal((await client.attempts()).length, 2);
});

test("every sector provisions approved fictional manuals, courses and home wording", async () => {
  const client = new LocalDemoClient(clock());
  for (const sector of FRAMEWORK_SECTORS) {
    await client.setSector(sector);
    const profile = await client.profile();
    assert.equal(profile.sector, sector);
    const hits = await client.search("", null);
    assert.equal(hits.length, 2, sector);
    assert.ok(hits.every((h) => h.fictionalTemplate));
    assert.ok((await client.courses()).every((c) => c.available), sector);
    assert.ok(HOME_WORDING[sector].start && HOME_WORDING[sector].active);
  }
});

function fakeFetch(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("http client: authenticated requests, mapped failures, and no automatic retries", async () => {
  const { calls, fetchImpl } = fakeFetch([
    json(200, { hits: [{ manualId: "m1" }] }),
    json(409, { error: { code: "FRAMEWORK_CONFLICT", message: "x", requestId: "r", details: { reason: "manual_version_stale" } } }),
    new TypeError("network down"),
    new Response("<html>bad gateway</html>", { status: 502 }),
    json(409, { error: { code: "CASE_VERSION_CONFLICT", message: "x", requestId: "r", details: { expectedVersion: 1, actualVersion: 2 } } }),
    json(403, { error: { code: "FORBIDDEN", message: "x", requestId: "r" } }),
  ]);
  const client = new HttpFrameworkClient({ baseUrl: "https://ops.example.test", tenantId: "tenant:a", accessTokenProvider: () => "tok-1", fetchImpl });

  assert.deepEqual(await client.search("転倒 記録", "incident"), [{ manualId: "m1" }]);
  const first = calls[0]!;
  assert.equal(first.url, "https://ops.example.test/api/framework/tenants/tenant%3Aa/manuals?q=%E8%BB%A2%E5%80%92+%E8%A8%98%E9%8C%B2&category=incident");
  assert.equal((first.init.headers as Record<string, string>).authorization, "Bearer tok-1");
  assert.equal(first.init.credentials, "omit");
  assert.equal(first.init.redirect, "error");

  await assert.rejects(
    client.openCase({ manualId: "m1", manualVersion: 1, signalId: "fw-1", subjectRef: "R-1" }),
    kind("conflict", "manual_version_stale"),
  );
  assert.equal(JSON.parse(String(calls[1]!.init.body)).signalId, "fw-1");
  await assert.rejects(client.checkStep("case-1", "s-1"), kind("network"));
  await assert.rejects(client.evidence("case-1"), kind("unavailable"));

  await assert.rejects(client.execute("case-1", 1, { type: "acknowledge" }), kind("conflict", "case_version"));
  assert.equal(calls[4]!.url, "https://ops.example.test/api/care-ops/tenants/tenant%3Aa/cases/case-1/commands");
  assert.deepEqual(JSON.parse(String(calls[4]!.init.body)), { expectedVersion: 1, command: { type: "acknowledge" } });
  await assert.rejects(client.cases(), kind("forbidden"));

  assert.equal(calls.length, 6, "each failure is reported once; nothing is re-sent automatically");
  await assert.rejects(client.manual("../x"), kind("invalid_input"));
  assert.equal(calls.length, 6, "unsafe identifiers never reach the network");
});

test("failure wording never claims a write succeeded", () => {
  for (const k of ["network", "unauthenticated", "forbidden", "not_found", "conflict", "invalid_transition", "invalid_input", "unavailable", "unknown"] as const) {
    const message = failureMessage(new FrameworkClientError(k), true);
    assert.match(message, /保存されていません|保存できたか確認できません/, k);
    assert.doesNotMatch(message, /保存しました|完了しました/, k);
  }
  assert.match(failureMessage(new FrameworkClientError("conflict", "case_version"), true), /最新の状態/);
});
