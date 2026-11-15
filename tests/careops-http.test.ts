import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryAiDraftStore,
  InMemoryAuditLogStore,
  InMemoryCaseRepository,
  InMemoryFacilitySettingsStore,
  InMemoryOutboxStore,
  InMemorySignalStore,
  InMemoryStaffNotificationInbox,
  LocalDevAuthenticator,
  RuleBasedDraftProvider,
  createLocalCareOpsApp,
} from "../src/index.ts";

const BASE = "http://localhost/api/care-ops/tenants/demo-tenant";

async function app() {
  const now = () => new Date().toISOString();
  return createLocalCareOpsApp({
    stores: {
      repository: new InMemoryCaseRepository(),
      signals: new InMemorySignalStore(),
      settings: new InMemoryFacilitySettingsStore(),
      audit: new InMemoryAuditLogStore(),
      drafts: new InMemoryAiDraftStore(),
      outbox: new InMemoryOutboxStore(now),
      inbox: new InMemoryStaffNotificationInbox(),
    },
    ai: new RuleBasedDraftProvider(),
    now,
  });
}

type App = Awaited<ReturnType<typeof app>>;

function client(instance: App, principal: string | null) {
  return async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = {};
    if (principal) headers.authorization = `Bearer local.${principal}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await instance.api.handle(
      new Request(`${BASE}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }),
    );
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
  };
}

test("local authenticator is fail-closed outside the local stage", async () => {
  assert.throws(() => new LocalDevAuthenticator({ stage: "production", principals: ["x"] }));
  assert.throws(() => new LocalDevAuthenticator({ stage: "staging", principals: ["x"] }));
  const auth = new LocalDevAuthenticator({ stage: "local", principals: ["known"] });
  await assert.rejects(auth.authenticate("local.unknown"));
  await assert.rejects(auth.authenticate("known"));
  assert.equal((await auth.authenticate("local.known")).principalId, "known");
});

test("HTTP: end-to-end CareOps workflow with server-side authorization", async () => {
  const instance = await app();
  const desk = client(instance, "dev-dispatcher-sakura");
  const r1 = client(instance, "dev-responder-sakura-1");
  const r2 = client(instance, "dev-responder-sakura-2");
  const lead = client(instance, "dev-supervisor-sakura");
  const kaede = client(instance, "dev-supervisor-kaede");
  const anon = client(instance, null);

  assert.equal((await anon("GET", "/dashboard")).status, 401);
  assert.equal((await client(instance, "nobody")("GET", "/dashboard")).status, 401);

  const me = await desk("GET", "/me");
  assert.equal(me.status, 200);
  assert.deepEqual(me.body.facilityScope, ["facility-sakura"]);
  assert.equal(me.body.facilities.length, 1);
  assert.equal(me.body.permissions.manage_settings, false);

  // notification arrives → staff turns it into a Case
  const signal = await desk("POST", "/signals", {
    facilityId: "facility-sakura", sourceAdapter: "line-relay", sourceSignalId: "msg-001", sourceType: "free_text",
    subjectId: "resident-ref-0101", rawText: "ご家族より: 夕方から食欲がないとの連絡。",
  });
  assert.equal(signal.status, 201);
  assert.equal(signal.body.outcome, "pending");
  const fromSignal = await desk("POST", `/signals/${signal.body.signal.id}/create-case`, {
    priority: "normal", category: "家族からの連絡", priorityRationale: "家族からの食欲低下の連絡",
  });
  assert.equal(fromSignal.status, 201);
  const caseId = fromSignal.body.aggregate.id as string;
  let version = fromSignal.body.aggregate.version as number;

  const command = async (who: typeof desk, payload: unknown) => {
    const result = await who("POST", `/cases/${caseId}/commands`, { expectedVersion: version, command: payload });
    if (result.status === 200) version = result.body.aggregate.version;
    return result;
  };

  assert.equal((await command(r1, { type: "acknowledge" })).status, 403, "responder cannot acknowledge");
  assert.equal((await command(desk, { type: "acknowledge" })).status, 200);
  assert.equal((await command(desk, { type: "triage", category: "食事・水分", priority: "high", rationale: "食欲低下が継続" })).status, 200);
  assert.equal((await command(lead, { type: "assign", assigneeId: "staff-kaede-r1" })).status, 403, "cross-facility assignee");
  assert.equal((await command(lead, { type: "assign", assigneeId: "staff-sakura-r1" })).status, 200);
  assert.equal((await command(r1, { type: "start_action" })).status, 200);
  assert.equal((await command(r1, { type: "add_note", kind: "observation", text: "居室訪問。水分は摂取できている。" })).status, 200);

  // AI provenance cannot be injected by a client
  const injected = await r1("POST", `/cases/${caseId}/commands`, {
    expectedVersion: version,
    command: { type: "add_note", kind: "other", text: "x", origin: { type: "ai_draft", draftId: "d", provider: "p", model: "m", generatedAt: "2026-01-01T00:00:00Z" } },
  });
  assert.equal(injected.status, 400);

  // stale version → 409
  const stale = await r1("POST", `/cases/${caseId}/commands`, { expectedVersion: version - 1, command: { type: "add_note", kind: "action", text: "late" } });
  assert.equal(stale.status, 409);

  assert.equal((await command(r1, { type: "request_handoff", targetAssigneeId: "staff-sakura-r2", note: "21時に再度様子確認" })).status, 200);
  const board = await r2("GET", "/handoffs");
  assert.equal(board.body.incoming[0].caseId, caseId);
  assert.equal((await command(r2, { type: "accept_handoff" })).status, 200);
  assert.equal(
    (await command(r2, { type: "complete", outcome: "confirmed_safe", summary: "夕食を半量摂取。家族へ報告済み", evidence: [{ kind: "call", ref: "call-log:synthetic-9" }] })).status,
    200,
  );

  const detail = await lead("GET", `/cases/${caseId}/detail`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.aggregate.status, "COMPLETED");
  assert.ok(detail.body.auditTrail.length >= 9);

  // other facility: no read, no list, no signal access
  assert.equal((await kaede("GET", `/cases/${caseId}/detail`)).status, 403);
  assert.equal((await kaede("GET", `/cases?facilityId=facility-sakura`)).status, 403);
  assert.equal((await kaede("GET", "/cases")).body.total, 0);
  assert.equal((await kaede("POST", `/signals/${signal.body.signal.id}/dismiss`, { reason: "x" })).status, 404);
  assert.equal((await kaede("GET", "/settings/facilities/facility-sakura")).status, 403);

  // legacy routes keep working on the same data
  const legacyCase = await lead("GET", `/cases/${caseId}`);
  assert.equal(legacyCase.status, 200);
  assert.equal(legacyCase.headers.get("x-case-version"), String(version));
  assert.equal((await lead("GET", "/queue")).status, 200);
  assert.equal((await kaede("GET", "/queue")).body.items.length, 0, "legacy queue enforces facility scope");
});

test("HTTP: input validation, method handling and safe errors", async () => {
  const instance = await app();
  const desk = client(instance, "dev-dispatcher-sakura");
  const lead = client(instance, "dev-supervisor-sakura");

  const unknownField = await desk("POST", "/cases", { facilityId: "facility-sakura", subjectId: "r", sourceType: "manual", priority: "low", tenantId: "x" });
  assert.equal(unknownField.status, 400);
  assert.match(unknownField.body.error.message, /unsupported field/);
  assert.equal((await desk("POST", "/cases", { facilityId: "facility-sakura", subjectId: "名前 入り", sourceType: "manual", priority: "low" })).status, 400);
  assert.equal((await desk("POST", "/cases", { facilityId: "facility-sakura", subjectId: "r-1", sourceType: "manual", priority: "urgent" })).status, 400);
  assert.equal((await desk("POST", "/cases", { facilityId: "facility-unknown", subjectId: "r-1", sourceType: "manual", priority: "low" })).status, 403);
  assert.equal((await desk("GET", "/cases?status=BOGUS")).status, 400);
  assert.equal((await desk("GET", "/cases?pageSize=1000")).status, 400);
  assert.equal((await desk("GET", "/analytics?from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z")).status, 200);
  assert.equal((await client(instance, "dev-responder-sakura-1")("GET", "/analytics?from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z")).status, 403);
  assert.equal((await desk("GET", "/analytics?from=2026-01-01")).status, 400);
  assert.equal((await desk("GET", "/cases/../../x/detail")).status, 404);

  const wrongMethod = await desk("DELETE", "/cases");
  assert.equal(wrongMethod.status, 405);
  assert.match(wrongMethod.headers.get("allow") ?? "", /GET/);

  const created = await desk("POST", "/cases", { facilityId: "facility-sakura", subjectId: "resident-ref-0201", sourceType: "unwell", priority: "critical", rawText: "呼吸が苦しいとの訴え" });
  assert.equal(created.status, 201);
  const notifications = await lead("GET", "/notifications");
  assert.equal(notifications.body[0].kind, "critical_unacknowledged");

  const settings = await lead("GET", "/settings/facilities/facility-sakura");
  const badSla = await lead("POST", "/settings/facilities/facility-sakura", {
    expectedVersion: settings.body.version,
    sla: { ...settings.body.sla, low: { ...settings.body.sla.low, completeWithinMs: 10 } },
  });
  assert.equal(badSla.status, 400);
  const approved = await lead("POST", "/settings/facilities/facility-sakura", { expectedVersion: settings.body.version, approveSla: { note: "施設会議で承認" } });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.slaApproval.status, "approved");
  assert.equal((await lead("POST", "/settings/facilities/facility-sakura", { expectedVersion: settings.body.version, displayName: "x" })).status, 409);
  assert.equal((await desk("POST", "/settings/facilities/facility-sakura", { expectedVersion: approved.body.version, displayName: "x" })).status, 403);

  const audit = await lead("GET", "/audit?limit=50");
  assert.equal(audit.status, 200);
  assert.ok(audit.body.some((entry: { action: string }) => entry.action === "settings.updated_and_sla_approved"));

  // errors never echo internals
  const notFound = await desk("GET", "/cases/case-does-not-exist/detail");
  assert.equal(notFound.status, 404);
  assert.deepEqual(Object.keys(notFound.body.error).sort(), ["code", "message", "requestId"]);
});

test("HTTP: AI draft flow and AI-disabled fallback", async () => {
  const instance = await app();
  const desk = client(instance, "dev-dispatcher-sakura");
  const created = await desk("POST", "/cases", { facilityId: "facility-sakura", subjectId: "resident-ref-0301", sourceType: "unwell", priority: "high", rawText: "20時 転倒の音あり。本人は痛みを訴えている。" });
  const caseId = created.body.aggregate.id;
  const draft = await desk("POST", `/cases/${caseId}/ai-drafts`, { kind: "handoff" });
  assert.equal(draft.status, 201);
  assert.equal(draft.body.status, "pending_review");
  assert.match(draft.body.content.text, /AI生成・未確認/);
  const review = await desk("POST", `/cases/${caseId}/ai-drafts/${draft.body.id}/review`, { decision: "approve", expectedVersion: created.body.aggregate.version });
  assert.equal(review.status, 200);
  assert.equal(review.body.operation.event.data.origin.provider, "local-rules");

  // AI disabled: drafts fail, core work continues
  const now = () => new Date().toISOString();
  const disabled = await createLocalCareOpsApp({
    stores: {
      repository: new InMemoryCaseRepository(), signals: new InMemorySignalStore(), settings: new InMemoryFacilitySettingsStore(),
      audit: new InMemoryAuditLogStore(), drafts: new InMemoryAiDraftStore(), outbox: new InMemoryOutboxStore(now), inbox: new InMemoryStaffNotificationInbox(),
    },
    now,
  });
  const desk2 = client(disabled, "dev-dispatcher-sakura");
  assert.equal((await desk2("GET", "/me")).body.aiAvailable, false);
  const c2 = await desk2("POST", "/cases", { facilityId: "facility-sakura", subjectId: "resident-ref-0302", sourceType: "manual", priority: "low" });
  const failed = await desk2("POST", `/cases/${c2.body.aggregate.id}/ai-drafts`, { kind: "case_summary" });
  assert.equal(failed.status, 201);
  assert.equal(failed.body.status, "failed");
  const ack = await desk2("POST", `/cases/${c2.body.aggregate.id}/commands`, { expectedVersion: 1, command: { type: "acknowledge" } });
  assert.equal(ack.status, 200);
});

test("HTTP: error responses never echo submitted personal data", async () => {
  const instance = await app();
  const desk = client(instance, "dev-dispatcher-sakura");
  const marker = "山田花子090-0000-0000";
  const attempts = [
    await desk("POST", "/cases", { facilityId: "facility-sakura", subjectId: marker, sourceType: "manual", priority: "low" }),
    await desk("POST", "/cases", { facilityId: "facility-sakura", subjectId: "r-1", sourceType: marker, priority: "low" }),
    await desk("POST", "/cases", { facilityId: "facility-sakura", subjectId: "r-1", sourceType: "manual", priority: "low", rawText: marker.repeat(400) }),
    await desk("POST", "/signals", { facilityId: marker, sourceAdapter: "phone", sourceSignalId: "x", sourceType: "manual", subjectId: "r" }),
    await desk("POST", "/cases/case-x/commands", { expectedVersion: 1, command: { type: "add_note", kind: marker, text: marker } }),
    await desk("GET", `/cases?q=${encodeURIComponent(marker.repeat(10))}`),
    await desk("GET", `/cases/${encodeURIComponent(marker)}/detail`),
  ];
  for (const attempt of attempts) {
    assert.ok(attempt.status >= 400, `rejected (${attempt.status})`);
    assert.ok(!JSON.stringify(attempt.body).includes("山田"), "no echo of submitted values");
    assert.deepEqual(Object.keys(attempt.body.error).sort(), ["code", "message", "requestId"]);
  }
});

test("HTTP: notes carry evidence and the detail lists every evidence reference", async () => {
  const instance = await app();
  const desk = client(instance, "dev-dispatcher-sakura");
  const created = await desk("POST", "/cases", { facilityId: "facility-sakura", subjectId: "resident-ref-0401", sourceType: "manual", priority: "normal", rawText: "合成" });
  const caseId = created.body.aggregate.id;
  const noted = await desk("POST", `/cases/${caseId}/commands`, {
    expectedVersion: 1,
    command: { type: "add_note", kind: "contact", text: "家族へ電話、不在", evidence: [{ kind: "call", ref: "call-log:synthetic-7" }] },
  });
  assert.equal(noted.status, 200);
  assert.equal((await desk("POST", `/cases/${caseId}/commands`, { expectedVersion: 2, command: { type: "add_note", kind: "other", text: "x", evidence: [{ kind: "bogus", ref: "r" }] } })).status, 400);
  assert.equal((await desk("POST", `/cases/${caseId}/commands`, { expectedVersion: 2, command: { type: "add_note", kind: "other", text: "x", evidence: Array.from({ length: 11 }, () => ({ kind: "note", ref: "n" })) } })).status, 400);
  const detail = await desk("GET", `/cases/${caseId}/detail`);
  assert.deepEqual(detail.body.evidence.map((item: { source: string; kind: string; ref: string; actorId: string; sequence: number }) => [item.sequence, item.source, item.kind, item.ref, item.actorId]),
    [[2, "note_added", "call", "call-log:synthetic-7", "staff-sakura-desk"]]);
});
