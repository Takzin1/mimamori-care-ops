import assert from "node:assert/strict";
import test from "node:test";

import {
  CareOpsConflictError,
  CareOpsNotFoundError,
  CareOpsPlatformService,
  CareOpsRuleError,
  CaseAccessDeniedError,
  CaseConflictError,
  InMemoryAiDraftStore,
  InMemoryAuditLogStore,
  InMemoryCaseRepository,
  InMemoryFacilitySettingsStore,
  InMemoryOutboxStore,
  InMemorySignalStore,
  InMemoryStaffNotificationInbox,
  InMemoryTenantMembershipDirectory,
  InvalidTransitionError,
  RuleBasedDraftProvider,
  defaultFacilitySettings,
  durationStat,
  type AiDraftProvider,
  type StaffNotificationChannel,
  type TenantMembership,
} from "../src/index.ts";

// Synthetic, non-identifying fixtures only.
const TENANT = "tenant-a";
const OTHER_TENANT = "tenant-b";

function m(principalId: string, actorId: string, roles: TenantMembership["roles"], facilityIds?: string[], tenantId = TENANT): TenantMembership {
  return { tenantId, principalId, actorId, roles, active: true, ...(facilityIds ? { facilityIds } : {}) };
}

class Clock {
  ms = Date.parse("2026-11-10T09:00:00.000Z");
  now = () => new Date(this.ms).toISOString();
  advance(minutes: number) { this.ms += minutes * 60_000; }
}

function setup(options: { ai?: AiDraftProvider; channels?: StaffNotificationChannel[] } = {}) {
  const clock = new Clock();
  let seq = 0;
  const newId = () => `id${String(++seq).padStart(4, "0")}`;
  const memberships = new InMemoryTenantMembershipDirectory([
    m("p-disp", "dispatcher-a", ["dispatcher"], ["fac-a"]),
    m("p-resp-a", "responder-a", ["responder"], ["fac-a"]),
    m("p-resp-b", "responder-b", ["responder"], ["fac-a"]),
    m("p-sup", "supervisor-a", ["supervisor"], ["fac-a"]),
    m("p-resp-x", "responder-x", ["responder"], ["fac-b"]),
    m("p-sup-x", "supervisor-x", ["supervisor"], ["fac-b"]),
    m("p-aud", "auditor-a", ["auditor"]),
    m("p-other", "other-sup", ["supervisor"], undefined, OTHER_TENANT),
  ]);
  const settings = new InMemoryFacilitySettingsStore([
    defaultFacilitySettings({ tenantId: TENANT, facilityId: "fac-a", displayName: "施設A", now: clock.now() }),
    defaultFacilitySettings({ tenantId: TENANT, facilityId: "fac-b", displayName: "施設B", now: clock.now() }),
    defaultFacilitySettings({ tenantId: OTHER_TENANT, facilityId: "fac-z", displayName: "施設Z", now: clock.now() }),
  ]);
  const outbox = new InMemoryOutboxStore(clock.now);
  const inbox = new InMemoryStaffNotificationInbox();
  const platform = new CareOpsPlatformService({
    repository: new InMemoryCaseRepository(),
    memberships,
    signals: new InMemorySignalStore(),
    settings,
    audit: new InMemoryAuditLogStore(),
    drafts: new InMemoryAiDraftStore(),
    outbox,
    inbox,
    ai: options.ai ?? new RuleBasedDraftProvider(),
    channels: options.channels,
    now: clock.now,
    newId,
    notificationRetryDelayMs: 60_000,
  });
  const ctx = (principalId: string, tenantId = TENANT) => ({ tenantId, principalId });
  return { platform, clock, ctx, outbox, inbox };
}

async function openCase(env: ReturnType<typeof setup>, overrides: Partial<{ priority: "critical" | "high" | "normal" | "low"; subjectId: string; facilityId: string }> = {}) {
  const result = await env.platform.createCase(env.ctx("p-disp"), {
    facilityId: overrides.facilityId ?? "fac-a",
    subjectId: overrides.subjectId ?? "resident-ref-0001",
    sourceType: "unwell",
    priority: overrides.priority ?? "high",
    category: "体調不良",
    priorityRationale: "本人から腹痛の訴え",
    rawText: "21:05 居室から呼出。本人より腹痛の訴えあり。発熱は不明。",
  });
  return result.aggregate;
}

test("completion criteria 1-8: create → acknowledge → assign → history → handoff receipt → resolve → timeline → dashboard", async () => {
  const env = setup();
  const { platform, ctx, clock } = env;

  // 1. staff creates a Case from a notification
  let aggregate = await openCase(env);
  assert.equal(aggregate.status, "NEW");
  assert.equal(aggregate.facilityId, "fac-a");
  assert.equal(aggregate.createdBy, "dispatcher-a");

  // 2. another staff member acknowledges (supervisor here)
  clock.advance(2);
  aggregate = (await platform.execute(ctx("p-sup"), aggregate.id, aggregate.version, { type: "acknowledge" })).aggregate;
  aggregate = (await platform.execute(ctx("p-sup"), aggregate.id, aggregate.version, {
    type: "triage", category: "体調不良", priority: "high", rationale: "腹痛の訴え。施設手順で高",
  })).aggregate;

  // 3. administrator assigns
  clock.advance(3);
  aggregate = (await platform.execute(ctx("p-sup"), aggregate.id, aggregate.version, { type: "assign", assigneeId: "responder-a" })).aggregate;

  // 4. assignee saves action history
  aggregate = (await platform.execute(ctx("p-resp-a"), aggregate.id, aggregate.version, { type: "start_action" })).aggregate;
  aggregate = (await platform.execute(ctx("p-resp-a"), aggregate.id, aggregate.version, {
    type: "add_note", kind: "observation", text: "21:15 訪問。会話可能、顔色良好。",
  })).aggregate;

  // 5. next shift receives the handoff
  aggregate = (await platform.execute(ctx("p-resp-a"), aggregate.id, aggregate.version, {
    type: "request_handoff", targetAssigneeId: "responder-b", note: "22時に再訪問予定",
  })).aggregate;
  let board = await platform.handoffBoard(ctx("p-resp-b"));
  assert.equal(board.incoming.length, 1);
  assert.equal(board.incoming[0]!.note, "22時に再訪問予定");
  aggregate = (await platform.execute(ctx("p-resp-b"), aggregate.id, aggregate.version, { type: "accept_handoff" })).aggregate;
  board = await platform.handoffBoard(ctx("p-resp-b"));
  assert.equal(board.incoming.length, 0);
  assert.equal(board.recent[0]!.action, "handoff_accepted");

  // 6. authorised staff resolves
  aggregate = (await platform.execute(ctx("p-resp-b"), aggregate.id, aggregate.version, {
    type: "complete", outcome: "confirmed_safe", summary: "再訪問し症状改善を確認", evidence: [{ kind: "visit", ref: "visit:synthetic-2" }],
  })).aggregate;
  assert.equal(aggregate.status, "COMPLETED");
  assert.equal(aggregate.completion?.completedBy, "responder-b");

  // 7. timeline / audit trail show the process
  const detail = await platform.caseDetail(ctx("p-sup"), aggregate.id);
  assert.deepEqual(detail.events.map((event) => event.type), [
    "case_created", "acknowledged", "triaged", "assigned", "action_started", "note_added",
    "handoff_requested", "handoff_accepted", "completed",
  ]);
  assert.equal(detail.signals.length, 1);
  assert.match(detail.signals[0]!.rawText ?? "", /腹痛/);
  assert.ok(detail.auditTrail.every((entry) => entry.at && (entry.actorId || entry.action === "case_created")));

  // 8. dashboard shows unresolved work
  const second = await openCase(env, { subjectId: "resident-ref-0002" });
  const dashboard = await platform.dashboard(ctx("p-sup"));
  assert.equal(dashboard.counts.unacknowledged, 1);
  assert.equal(dashboard.counts.resolved, 1);
  assert.equal(dashboard.attention[0]!.caseId, second.id);
});

test("9. facility and tenant isolation: no cross-facility read, write, list or IDOR", async () => {
  const env = setup();
  const { platform, ctx } = env;
  const caseA = await openCase(env);

  await assert.rejects(platform.caseDetail(ctx("p-sup-x"), caseA.id), CaseAccessDeniedError);
  await assert.rejects(platform.caseDetail(ctx("p-resp-x"), caseA.id), CaseAccessDeniedError);
  await assert.rejects(platform.execute(ctx("p-sup-x"), caseA.id, caseA.version, { type: "acknowledge" }), CaseAccessDeniedError);

  const listX = await platform.listCases(ctx("p-sup-x"), {});
  assert.equal(listX.total, 0);
  await assert.rejects(platform.listCases(ctx("p-sup-x"), { facilityId: "fac-a" }), CaseAccessDeniedError);
  await assert.rejects(platform.dashboard(ctx("p-sup-x"), "fac-a"), CaseAccessDeniedError);

  // other tenant cannot address the Case at all (tenant-scoped storage)
  assert.equal(await platform.caseService.get({ tenantId: OTHER_TENANT, caseId: caseA.id, principalId: "p-other" }), null);
  await assert.rejects(platform.caseDetail(ctx("p-other", OTHER_TENANT), caseA.id));
  // principal of tenant A has no membership in tenant B
  await assert.rejects(platform.dashboard(ctx("p-sup", OTHER_TENANT)), CaseAccessDeniedError);

  // facility_id supplied by the client is not trusted
  await assert.rejects(
    platform.createCase(ctx("p-disp"), { facilityId: "fac-b", subjectId: "s", sourceType: "manual", priority: "low" }),
    CaseAccessDeniedError,
  );

  // cannot assign a Case to staff of another facility
  let aggregate = (await platform.execute(ctx("p-sup"), caseA.id, caseA.version, { type: "acknowledge" })).aggregate;
  await assert.rejects(
    platform.execute(ctx("p-sup"), aggregate.id, aggregate.version, { type: "assign", assigneeId: "responder-x" }),
    CaseAccessDeniedError,
  );

  // signals of another facility are reported as missing (no existence oracle)
  const pending = await platform.ingestSignal(ctx("p-disp"), {
    facilityId: "fac-a", sourceAdapter: "line", sourceSignalId: "msg-1", sourceType: "free_text", subjectId: "resident-ref-0009", rawText: "テスト",
  });
  await assert.rejects(platform.dismissSignal(ctx("p-sup-x"), pending.signal.id, "x"), CareOpsNotFoundError);
  assert.equal((await platform.listSignals(ctx("p-sup-x"))).length, 0);

  // staff roster does not leak other facilities
  const roster = await platform.staff(ctx("p-sup-x"));
  assert.ok(roster.every((member) => member.facilityIds === null || member.facilityIds.includes("fac-b")));
});

test("10. unauthorized access and privilege escalation are rejected", async () => {
  const env = setup();
  const { platform, ctx } = env;
  const created = await openCase(env);

  await assert.rejects(platform.execute(ctx("p-resp-a"), created.id, created.version, { type: "acknowledge" }), CaseAccessDeniedError);
  await assert.rejects(platform.execute(ctx("p-aud"), created.id, created.version, { type: "add_note", kind: "other", text: "x" }), CaseAccessDeniedError);
  await assert.rejects(platform.updateSettings(ctx("p-disp"), "fac-a", 1, { approveSla: {} }), CaseAccessDeniedError);
  await assert.rejects(platform.auditLog(ctx("p-resp-a")), CaseAccessDeniedError);
  await assert.rejects(platform.runEscalations(ctx("p-disp")), CaseAccessDeniedError);
  await assert.rejects(platform.analytics(ctx("p-resp-a"), { from: "2026-11-01T00:00:00Z", to: "2026-11-11T00:00:00Z" }), CaseAccessDeniedError);
  await assert.rejects(platform.dashboard(ctx("p-unknown")), CaseAccessDeniedError);
  // responder can read a Case only when it is theirs
  await assert.rejects(platform.caseDetail(ctx("p-resp-b"), created.id), CaseAccessDeniedError);
  // only supervisors may reopen
  await assert.rejects(platform.execute(ctx("p-disp"), created.id, created.version, { type: "reopen", reason: "x" }), CaseAccessDeniedError);
});

test("3. duplicate notifications: same id is idempotent, same subject links to the open Case", async () => {
  const env = setup();
  const { platform, ctx } = env;
  const input = { facilityId: "fac-a", sourceAdapter: "sensor", sourceSignalId: "evt-77", sourceType: "non_response" as const, subjectId: "resident-ref-0003", rawText: "6時間動きなし" };

  const first = await platform.ingestSignal(ctx("p-disp"), input);
  assert.equal(first.outcome, "pending");
  const replay = await platform.ingestSignal(ctx("p-disp"), input);
  assert.equal(replay.outcome, "replay");
  assert.equal(replay.signal.id, first.signal.id);
  assert.equal(replay.signal.replayCount, 1);

  const opened = await platform.createCaseFromSignal(ctx("p-disp"), first.signal.id, { priority: "high", priorityRationale: "長時間無動作" });
  await assert.rejects(platform.createCaseFromSignal(ctx("p-disp"), first.signal.id, { priority: "high" }), CareOpsConflictError);

  const second = await platform.ingestSignal(ctx("p-disp"), { ...input, sourceSignalId: "evt-78" });
  assert.equal(second.outcome, "linked");
  assert.equal(second.caseId, opened.aggregate.id);

  const detail = await platform.caseDetail(ctx("p-disp"), opened.aggregate.id);
  assert.equal(detail.aggregate.linkedSignalCount, 1);
  assert.equal(detail.events.at(-1)!.type, "signal_linked");
  assert.equal(detail.signals.length, 2);

  const page = await platform.listCases(ctx("p-disp"), {});
  assert.equal(page.total, 1, "duplicate notifications must not create extra Cases");

  // auto-create rule (SOS) opens a critical Case and notifies supervisors
  const sos = await platform.ingestSignal(ctx("p-disp"), { ...input, sourceType: "sos", sourceSignalId: "sos-1", subjectId: "resident-ref-0004" });
  assert.equal(sos.outcome, "case_created");
  const notifications = await platform.notifications(ctx("p-sup"));
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]!.kind, "critical_unacknowledged");
  assert.ok(!notifications[0]!.message.includes("resident-ref"), "notifications carry no resident identifiers");
});

test("4. concurrent updates: stale version loses, no silent overwrite", async () => {
  const env = setup();
  const { platform, ctx } = env;
  const created = await openCase(env);
  const results = await Promise.allSettled([
    platform.execute(ctx("p-disp"), created.id, created.version, { type: "acknowledge" }),
    platform.execute(ctx("p-sup"), created.id, created.version, { type: "acknowledge" }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
  assert.ok(rejected.reason instanceof CaseConflictError);

  // settings use compare-and-set too
  const settings = await platform.getSettings(ctx("p-sup"), "fac-a");
  await platform.updateSettings(ctx("p-sup"), "fac-a", settings.version, { displayName: "施設A（本館）" });
  await assert.rejects(platform.updateSettings(ctx("p-sup"), "fac-a", settings.version, { displayName: "x" }), CareOpsConflictError);
});

test("5/6. reassignment and unaccepted handoff visibility; shift-end check", async () => {
  const env = setup();
  const { platform, ctx, clock } = env;
  let aggregate = await openCase(env);
  aggregate = (await platform.execute(ctx("p-disp"), aggregate.id, aggregate.version, { type: "acknowledge" })).aggregate;
  aggregate = (await platform.execute(ctx("p-disp"), aggregate.id, aggregate.version, { type: "assign", assigneeId: "responder-a" })).aggregate;
  aggregate = (await platform.execute(ctx("p-resp-a"), aggregate.id, aggregate.version, { type: "start_action" })).aggregate;

  let board = await platform.handoffBoard(ctx("p-resp-a"));
  assert.deepEqual(board.shiftEnd.map((item) => item.caseId), [aggregate.id], "own open Cases need a handoff before shift end");

  aggregate = (await platform.execute(ctx("p-resp-a"), aggregate.id, aggregate.version, { type: "request_handoff", targetAssigneeId: "responder-b", note: "申し送り" })).aggregate;
  clock.advance(45);
  board = await platform.handoffBoard(ctx("p-sup"));
  assert.equal(board.unaccepted.length, 1);
  assert.equal(board.unaccepted[0]!.waitingMinutes, 45);
  assert.equal(board.unaccepted[0]!.overdue, true, "provisional high-priority handoff target is 30 minutes");

  const escalation = await platform.runEscalations(ctx("p-sup"));
  assert.ok(escalation.enqueued >= 1);
  const again = await platform.runEscalations(ctx("p-sup"));
  assert.equal(again.enqueued, 0, "same breach is not notified twice");
  assert.ok(again.suppressedDuplicates >= 1);

  // the outgoing responder is gone: supervisor reassigns (代理対応)
  aggregate = (await platform.execute(ctx("p-sup"), aggregate.id, aggregate.version, { type: "reassign", assigneeId: "supervisor-a", reason: "引継ぎ先不在" })).aggregate;
  assert.equal(aggregate.status, "IN_PROGRESS");
  assert.equal(aggregate.assigneeId, "supervisor-a");
  board = await platform.handoffBoard(ctx("p-sup"));
  assert.equal(board.unaccepted.length, 0);
  assert.equal(board.recent[0]!.action, "reassigned");
});

test("7. resolve and reopen through the platform keep the history", async () => {
  const env = setup();
  const { platform, ctx } = env;
  let aggregate = await openCase(env);
  aggregate = (await platform.execute(ctx("p-sup"), aggregate.id, aggregate.version, { type: "acknowledge" })).aggregate;
  aggregate = (await platform.execute(ctx("p-sup"), aggregate.id, aggregate.version, { type: "assign", assigneeId: "supervisor-a" })).aggregate;
  aggregate = (await platform.execute(ctx("p-sup"), aggregate.id, aggregate.version, { type: "start_action" })).aggregate;
  await assert.rejects(
    platform.execute(ctx("p-sup"), aggregate.id, aggregate.version, { type: "close" }),
    InvalidTransitionError,
    "cannot close without resolution",
  );
  aggregate = (await platform.execute(ctx("p-sup"), aggregate.id, aggregate.version, { type: "complete", outcome: "false_alarm", summary: "誤報", evidence: [{ kind: "note", ref: "n:1" }] })).aggregate;
  aggregate = (await platform.execute(ctx("p-disp"), aggregate.id, aggregate.version, { type: "close" })).aggregate;
  aggregate = (await platform.execute(ctx("p-sup"), aggregate.id, aggregate.version, { type: "reopen", reason: "再発" })).aggregate;
  assert.equal(aggregate.reopenedCount, 1);
  const analytics = await platform.analytics(ctx("p-sup"), { from: "2026-11-10T00:00:00Z", to: "2026-11-11T00:00:00Z" });
  assert.equal(analytics.cases.reopened, 1);
});

test("11. AI failure, pending review and human approval", async () => {
  // failure path: provider down → failed draft, Case work continues
  const failing: AiDraftProvider = { name: "remote", model: "m1", async generate() { throw new Error("upstream 503"); } };
  const down = setup({ ai: failing });
  const created = await openCase(down);
  const failed = await down.platform.requestAiDraft(down.ctx("p-disp"), created.id, "case_summary");
  assert.equal(failed.status, "failed");
  assert.ok(!failed.error!.includes("503"), "provider internals are not leaked");
  const ack = await down.platform.execute(down.ctx("p-disp"), created.id, created.version, { type: "acknowledge" });
  assert.equal(ack.aggregate.status, "ACKNOWLEDGED");

  // happy path with deterministic local provider
  const env = setup();
  const { platform, ctx } = env;
  let aggregate = await openCase(env);
  const draft = await platform.requestAiDraft(ctx("p-disp"), aggregate.id, "case_summary");
  assert.equal(draft.status, "pending_review");
  assert.equal(draft.provider, "local-rules");
  assert.ok(draft.content!.facts.length > 0);
  assert.ok(draft.content!.facts.every((fact) => fact.verified), "every extracted quote exists in the source");
  assert.ok(draft.content!.uncertain.some((item) => item.includes("不明")), "uncertain statements are held back");
  assert.ok(draft.content!.missing.length > 0);

  // pending draft is NOT part of the Case record
  let detail = await platform.caseDetail(ctx("p-disp"), aggregate.id);
  assert.ok(!detail.events.some((event) => event.type === "note_added"));

  // stale case version is refused and the draft stays pending
  await assert.rejects(
    platform.reviewAiDraft(ctx("p-disp"), aggregate.id, draft.id, { decision: "approve", expectedVersion: 99 }),
    CaseConflictError,
  );
  detail = await platform.caseDetail(ctx("p-disp"), aggregate.id);
  assert.equal(detail.drafts[0]!.status, "pending_review");

  const approved = await platform.reviewAiDraft(ctx("p-disp"), aggregate.id, draft.id, {
    decision: "approve", expectedVersion: aggregate.version, text: "職員確認済みサマリー: 腹痛の訴えあり",
  });
  assert.equal(approved.draft.status, "approved");
  assert.equal(approved.draft.reviewedBy, "dispatcher-a");
  const note = approved.operation!.event;
  assert.equal(note.type, "note_added");
  if (note.type === "note_added") {
    assert.equal(note.actorId, "dispatcher-a", "the human approver is accountable");
    assert.deepEqual(note.data.origin, { type: "ai_draft", draftId: draft.id, provider: "local-rules", model: "careops-extract-v1", generatedAt: draft.generatedAt });
  }
  await assert.rejects(
    platform.reviewAiDraft(ctx("p-disp"), aggregate.id, draft.id, { decision: "approve", expectedVersion: approved.operation!.aggregate.version }),
    CareOpsConflictError,
  );

  // unverified facts require explicit acknowledgement
  const hallucinating: AiDraftProvider = {
    name: "remote", model: "m2",
    async generate() { return { text: "要約", facts: [{ label: "体温", value: "38度", quote: "体温38度", sourceRef: "signal:none" }], missing: [], uncertain: [] }; },
  };
  const env2 = setup({ ai: hallucinating });
  aggregate = await openCase(env2);
  const risky = await env2.platform.requestAiDraft(env2.ctx("p-disp"), aggregate.id, "fact_extraction");
  assert.equal(risky.content!.facts[0]!.verified, false);
  assert.ok(risky.content!.warnings.length > 0);
  await assert.rejects(
    env2.platform.reviewAiDraft(env2.ctx("p-disp"), aggregate.id, risky.id, { decision: "approve", expectedVersion: aggregate.version }),
    CareOpsRuleError,
  );
  const rejected = await env2.platform.reviewAiDraft(env2.ctx("p-disp"), aggregate.id, risky.id, { decision: "reject", expectedVersion: aggregate.version, note: "原文に体温記載なし" });
  assert.equal(rejected.draft.status, "rejected");
});

test("12. external notification failure is recorded and retried, then dead-lettered", async () => {
  let failuresLeft = 2;
  const flaky: StaffNotificationChannel = {
    name: "flaky-external",
    async deliver() {
      if (failuresLeft > 0) { failuresLeft -= 1; throw new Error("channel timeout"); }
    },
  };
  const env = setup({ channels: [flaky] });
  const { platform, ctx, clock } = env;
  await openCase(env, { priority: "critical" });

  let status = await platform.deliveryStatus(ctx("p-sup"));
  assert.equal(status[0]!.status, "failed");
  assert.equal(status[0]!.lastError, "channel timeout");
  assert.equal(status[0]!.attemptCount, 1);

  clock.advance(1);
  await platform.deliverNotifications(TENANT);
  status = await platform.deliveryStatus(ctx("p-sup"));
  assert.equal(status[0]!.status, "failed");
  assert.equal(status[0]!.attemptCount, 2);

  clock.advance(1);
  await platform.deliverNotifications(TENANT);
  status = await platform.deliveryStatus(ctx("p-sup"));
  assert.equal(status[0]!.status, "delivered");
  const inbox = await platform.notifications(ctx("p-sup"));
  assert.equal(inbox.length, 1, "in-app delivery is idempotent across retries");

  // permanent failure → dead letter after max attempts
  const broken: StaffNotificationChannel = { name: "broken", async deliver() { throw new Error("down"); } };
  const env2 = setup({ channels: [broken] });
  await openCase(env2, { priority: "critical" });
  for (let attempt = 0; attempt < 6; attempt += 1) {
    env2.clock.advance(2);
    await env2.platform.deliverNotifications(TENANT);
  }
  const dead = await env2.platform.deliveryStatus(env2.ctx("p-sup"));
  assert.equal(dead[0]!.status, "dead_letter");
  assert.equal(dead[0]!.attemptCount, 5);
});

test("settings: SLA change resets approval; approval is attributed and audited", async () => {
  const env = setup();
  const { platform, ctx } = env;
  let settings = await platform.getSettings(ctx("p-sup"), "fac-a");
  assert.equal(settings.slaApproval.status, "unapproved");
  settings = await platform.updateSettings(ctx("p-sup"), "fac-a", settings.version, { approveSla: { note: "運営会議で承認" } });
  assert.equal(settings.slaApproval.status, "approved");
  assert.equal(settings.slaApproval.approvedBy, "supervisor-a");

  const sla = structuredClone(settings.sla);
  sla.high.acknowledgeWithinMs = 10 * 60_000;
  settings = await platform.updateSettings(ctx("p-sup"), "fac-a", settings.version, { sla });
  assert.equal(settings.slaApproval.status, "unapproved", "changed thresholds need a new approval");

  await assert.rejects(
    platform.updateSettings(ctx("p-sup"), "fac-a", settings.version, { sla: { ...sla, high: { ...sla.high, acknowledgeWithinMs: -1 } } }),
  );
  const audit = await platform.auditLog(ctx("p-sup"));
  assert.equal(audit.filter((entry) => entry.source === "platform" && entry.targetType === "settings").length, 2);
  const auditorView = await platform.auditLog(ctx("p-aud"));
  assert.ok(auditorView.length >= 2);
});

test("list: filter, search, sort and paginate within scope", async () => {
  const env = setup();
  const { platform, ctx } = env;
  for (let index = 0; index < 5; index += 1) {
    env.clock.advance(1);
    await openCase(env, { subjectId: `resident-ref-10${index}`, priority: index === 3 ? "critical" : "normal" });
  }
  const page1 = await platform.listCases(ctx("p-disp"), { pageSize: 2, page: 1 });
  assert.equal(page1.total, 5);
  assert.equal(page1.totalPages, 3);
  assert.equal(page1.items[0]!.priority, "critical", "attention sort puts critical unacknowledged first");
  assert.equal(page1.items[0]!.needsHumanReview, true);

  const search = await platform.listCases(ctx("p-disp"), { query: "resident-ref-102" });
  assert.equal(search.total, 1);
  const byCreated = await platform.listCases(ctx("p-disp"), { sort: "createdAt", order: "desc" });
  assert.equal(byCreated.items[0]!.subjectId, "resident-ref-104");
  const unassigned = await platform.listCases(ctx("p-disp"), { assigneeId: "__unassigned__", priorities: ["normal"] });
  assert.equal(unassigned.total, 4);
  const oversized = await platform.listCases(ctx("p-disp"), { pageSize: 10_000 });
  assert.equal(oversized.pageSize, 100);
});

test("analytics: median, p90, counts, missing and explicit denominators", async () => {
  assert.deepEqual(durationStat([60_000, 120_000, 180_000, null]), {
    count: 3, missing: 1, meanMinutes: 2, medianMinutes: 2, p90Minutes: 3,
  });
  assert.deepEqual(durationStat([]), { count: 0, missing: 0, meanMinutes: null, medianMinutes: null, p90Minutes: null });

  const env = setup();
  const { platform, ctx, clock } = env;
  const a = await openCase(env, { subjectId: "r-1" });
  clock.advance(4);
  await platform.execute(ctx("p-disp"), a.id, a.version, { type: "acknowledge" });
  await openCase(env, { subjectId: "r-2" });
  await platform.ingestSignal(ctx("p-disp"), { facilityId: "fac-a", sourceAdapter: "line", sourceSignalId: "m-1", sourceType: "free_text", subjectId: "r-3" });

  const short = await platform.analytics(ctx("p-sup"), { from: "2026-11-10T00:00:00Z", to: "2026-11-11T00:00:00Z" });
  assert.equal(short.signals.received, 3, "notifications counted separately");
  assert.equal(short.cases.created, 2);
  assert.equal(short.durations.timeToAcknowledge.count, 1);
  assert.equal(short.durations.timeToAcknowledge.missing, 1);
  assert.equal(short.durations.timeToAcknowledge.medianMinutes, 4);
  assert.equal(short.frequency.casesPerWeek, null, "no weekly rate for a 1-day window");

  const long = await platform.analytics(ctx("p-sup"), { from: "2026-11-04T00:00:00Z", to: "2026-11-18T00:00:00Z" });
  assert.equal(long.period.observedDays, 14);
  assert.equal(long.frequency.casesPerWeek, 1);
  assert.match(long.frequency.note, /14日/);

  await assert.rejects(platform.analytics(ctx("p-sup"), { from: "2026-11-11T00:00:00Z", to: "2026-11-10T00:00:00Z" }), CareOpsRuleError);
});

test("signals can be dismissed with a reason by intake roles only", async () => {
  const env = setup();
  const { platform, ctx } = env;
  const signal = await platform.ingestSignal(ctx("p-resp-a"), { facilityId: "fac-a", sourceAdapter: "line", sourceSignalId: "m-9", sourceType: "free_text", subjectId: "r-9", rawText: "了解しました" });
  await assert.rejects(platform.dismissSignal(ctx("p-resp-a"), signal.signal.id, "x"), CaseAccessDeniedError);
  await assert.rejects(platform.dismissSignal(ctx("p-disp"), signal.signal.id, "  "), CareOpsRuleError);
  const dismissed = await platform.dismissSignal(ctx("p-disp"), signal.signal.id, "返信メッセージのみ。対応不要");
  assert.equal(dismissed.disposition, "dismissed");
  await assert.rejects(platform.createCaseFromSignal(ctx("p-disp"), signal.signal.id, { priority: "low" }), CareOpsConflictError);
});

test("escalation re-evaluation is idempotent for critical and SLA notifications", async () => {
  const env = setup();
  const { platform, ctx, clock } = env;
  await openCase(env, { priority: "critical" });
  clock.advance(10);
  const first = await platform.runEscalations(ctx("p-sup"));
  assert.ok(first.suppressedDuplicates >= 1, "creation-time critical notification is not duplicated");
  const second = await platform.runEscalations(ctx("p-sup"));
  assert.equal(second.enqueued, 0);
  const inbox = await platform.notifications(ctx("p-sup"));
  assert.equal(inbox.filter((item) => item.kind === "critical_unacknowledged").length, 1);
  assert.ok(inbox.some((item) => item.kind === "sla_breach"), "acknowledge target (5 min, provisional) breached");
});

test("double submit with the same clientRequestId never creates a duplicate Case", async () => {
  const env = setup();
  const { platform, ctx } = env;
  const input = { clientRequestId: "req-001", facilityId: "fac-a", subjectId: "resident-ref-0700", sourceType: "manual" as const, priority: "normal" as const, rawText: "同じ送信" };
  const [first, second] = await Promise.all([
    platform.createCase(ctx("p-disp"), input).catch((error: unknown) => error),
    platform.createCase(ctx("p-disp"), input).catch((error: unknown) => error),
  ]);
  const third = await platform.createCase(ctx("p-disp"), input);
  const created = [first, second].filter((item) => !(item instanceof Error)) as Array<{ aggregate: { id: string }; replayed: boolean }>;
  assert.ok(created.length >= 1);
  for (const item of created) assert.equal(item.aggregate.id, third.aggregate.id);
  assert.equal(third.replayed, true);
  assert.equal((await platform.listCases(ctx("p-disp"), {})).total, 1);
  await assert.rejects(platform.createCase(ctx("p-disp"), { ...input, subjectId: "resident-ref-0701" }), CareOpsConflictError);
  // the same key from another staff member is a different request
  const other = await platform.createCase(ctx("p-sup"), input);
  assert.notEqual(other.aggregate.id, third.aggregate.id);
});
