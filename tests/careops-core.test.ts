import assert from "node:assert/strict";
import test from "node:test";

import {
  CaseConflictError,
  InvalidTransitionError,
  createCase,
  executeCommand,
  linkSignalToCase,
  projectCaseAuditTrail,
  replayCase,
  type CaseAggregate,
  type CaseCommand,
  type CaseEvent,
} from "../src/index.ts";

// Synthetic identifiers only. No resident names or real records.
const T0 = Date.parse("2026-11-10T00:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

function newCase(overrides: Partial<Parameters<typeof createCase>[0]> = {}) {
  return createCase({
    id: "case-core-1",
    tenantId: "tenant-a",
    facilityId: "facility-a",
    subjectId: "resident-ref-0001",
    sourceType: "unwell",
    sourceAdapter: "manual-entry",
    sourceSignalId: "sig-1",
    priority: "normal",
    category: "体調不良",
    createdAt: at(0),
    createdBy: "dispatcher-a",
    ...overrides,
  });
}

class Flow {
  aggregate: CaseAggregate;
  events: CaseEvent[];
  minute = 0;

  constructor() {
    const created = newCase();
    this.aggregate = created.aggregate;
    this.events = [created.event];
  }

  run(command: CaseCommand): this {
    this.minute += 1;
    const result = executeCommand(
      this.aggregate,
      this.aggregate.version,
      command,
      at(this.minute),
    );
    this.aggregate = result.aggregate;
    this.events.push(result.event);
    return this;
  }
}

test("full CareOps lifecycle NEW→ACKNOWLEDGED→TRIAGED→ASSIGNED→IN_PROGRESS→COMPLETED→CLOSED", () => {
  const flow = new Flow();
  assert.equal(flow.aggregate.facilityId, "facility-a");
  assert.equal(flow.aggregate.createdBy, "dispatcher-a");
  assert.equal(flow.aggregate.category, "体調不良");

  flow.run({ type: "acknowledge", actorId: "dispatcher-a" });
  assert.equal(flow.aggregate.status, "ACKNOWLEDGED");

  flow.run({
    type: "triage",
    actorId: "dispatcher-a",
    category: "転倒",
    priority: "high",
    rationale: "居室内で転倒の申告。施設手順に基づき高に設定",
  });
  assert.equal(flow.aggregate.status, "TRIAGED");
  assert.equal(flow.aggregate.priority, "high");
  assert.equal(flow.aggregate.category, "転倒");
  assert.match(flow.aggregate.priorityRationale ?? "", /施設手順/);

  flow.run({ type: "assign", actorId: "supervisor-a", assigneeId: "responder-a" });
  assert.equal(flow.aggregate.status, "ASSIGNED");

  flow.run({ type: "start_action", actorId: "responder-a" });
  flow.run({
    type: "add_note",
    actorId: "responder-a",
    kind: "observation",
    text: "居室訪問。本人と会話可能",
  });
  assert.equal(flow.aggregate.lastCheckedAt, at(flow.minute));

  flow.run({
    type: "complete",
    actorId: "responder-a",
    outcome: "visit_completed",
    summary: "訪問し状態確認済み",
    evidence: [{ kind: "visit", ref: "visit-log:synthetic-1" }],
  });
  assert.equal(flow.aggregate.status, "COMPLETED");
  assert.equal(flow.aggregate.completion?.completedBy, "responder-a");

  flow.run({ type: "close", actorId: "supervisor-a" });
  assert.equal(flow.aggregate.status, "CLOSED");

  assert.deepEqual(replayCase(flow.events), flow.aggregate);
  assert.deepEqual(
    replayCase(JSON.parse(JSON.stringify(flow.events))),
    flow.aggregate,
    "JSON round-trip replay must equal the snapshot (Postgres divergence guard)",
  );
});

test("legacy flows without triage still work (ACKNOWLEDGED→ASSIGNED)", () => {
  const legacy = createCase({
    id: "legacy",
    tenantId: "t",
    subjectId: "s",
    sourceType: "manual",
    sourceAdapter: "a",
    sourceSignalId: "x",
    priority: "low",
    createdAt: at(0),
  });
  assert.deepEqual(Object.keys(legacy.event.data).sort(), [
    "caseId",
    "priority",
    "sourceAdapter",
    "sourceSignalId",
    "sourceType",
    "subjectId",
    "tenantId",
  ]);
  assert.equal(legacy.event.actorId, null);
  assert.equal(legacy.aggregate.facilityId, null);

  let aggregate = executeCommand(legacy.aggregate, 1, { type: "acknowledge", actorId: "d" }, at(1)).aggregate;
  aggregate = executeCommand(aggregate, 2, { type: "assign", actorId: "d", assigneeId: "r" }, at(2)).aggregate;
  assert.equal(aggregate.status, "ASSIGNED");
});

test("forbidden transitions are rejected", () => {
  const flow = new Flow();

  const reject = (command: CaseCommand) =>
    assert.throws(
      () => executeCommand(flow.aggregate, flow.aggregate.version, command, at(99)),
      InvalidTransitionError,
    );

  // cannot triage or assign before acknowledgement
  reject({ type: "triage", actorId: "d", category: "x", priority: "high", rationale: "r" });
  reject({ type: "assign", actorId: "d", assigneeId: "r" });
  // cannot complete / close / resolve from NEW
  reject({ type: "complete", actorId: "d", outcome: "other", summary: "s", evidence: [{ kind: "note", ref: "n" }] });
  reject({ type: "close", actorId: "d" });
  reject({ type: "reopen", actorId: "d", reason: "r" });
  reject({ type: "clear_escalation", actorId: "s", reason: "r" });

  flow.run({ type: "acknowledge", actorId: "dispatcher-a" });
  // triage requires a rationale
  reject({ type: "triage", actorId: "d", category: "x", priority: "high", rationale: "  " });

  flow.run({ type: "assign", actorId: "dispatcher-a", assigneeId: "responder-a" });
  // only the assignee may start
  reject({ type: "start_action", actorId: "responder-b" });
  // reassign to the same person is not a change
  reject({ type: "reassign", actorId: "s", assigneeId: "responder-a", reason: "r" });

  flow.run({ type: "start_action", actorId: "responder-a" });
  // completion without evidence is not allowed
  reject({ type: "complete", actorId: "responder-a", outcome: "other", summary: "s", evidence: [] });
  // close requires COMPLETED (no automatic or status-only close)
  reject({ type: "close", actorId: "supervisor-a" });
});

test("handoff with 申し送り, decline keeps the outgoing owner accountable", () => {
  const flow = new Flow();
  flow.run({ type: "acknowledge", actorId: "d" })
    .run({ type: "assign", actorId: "d", assigneeId: "responder-a" })
    .run({ type: "start_action", actorId: "responder-a" })
    .run({
      type: "request_handoff",
      actorId: "responder-a",
      targetAssigneeId: "responder-b",
      note: "21時に再訪問予定。水分摂取を確認",
    });

  assert.equal(flow.aggregate.status, "HANDOFF_PENDING");
  assert.equal(flow.aggregate.assigneeId, "responder-a", "no ownership gap");
  assert.equal(flow.aggregate.handoffNote, "21時に再訪問予定。水分摂取を確認");

  assert.throws(
    () => executeCommand(flow.aggregate, flow.aggregate.version, { type: "decline_handoff", actorId: "responder-c", reason: "x" }, at(50)),
    InvalidTransitionError,
  );

  flow.run({ type: "decline_handoff", actorId: "responder-b", reason: "別フロア対応中" });
  assert.equal(flow.aggregate.status, "IN_PROGRESS");
  assert.equal(flow.aggregate.assigneeId, "responder-a");
  assert.equal(flow.aggregate.handoffTargetId, null);
  assert.equal(flow.aggregate.handoffNote, null);

  flow.run({ type: "request_handoff", actorId: "responder-a", targetAssigneeId: "responder-b" })
    .run({ type: "cancel_handoff", actorId: "responder-a", reason: "勤務延長" });
  assert.equal(flow.aggregate.status, "IN_PROGRESS");

  flow.run({ type: "request_handoff", actorId: "responder-a", targetAssigneeId: "responder-b" })
    .run({ type: "accept_handoff", actorId: "responder-b" });
  assert.equal(flow.aggregate.assigneeId, "responder-b");
});

test("reassignment covers absent assignee and pending handoff (代理対応)", () => {
  const flow = new Flow();
  flow.run({ type: "acknowledge", actorId: "d" })
    .run({ type: "assign", actorId: "d", assigneeId: "responder-a" })
    .run({ type: "reassign", actorId: "supervisor-a", assigneeId: "responder-c", reason: "担当不在" });
  assert.equal(flow.aggregate.status, "ASSIGNED");
  assert.equal(flow.aggregate.assigneeId, "responder-c");

  flow.run({ type: "start_action", actorId: "responder-c" })
    .run({ type: "request_handoff", actorId: "responder-c", targetAssigneeId: "responder-b" })
    .run({ type: "reassign", actorId: "supervisor-a", assigneeId: "responder-d", reason: "引継ぎ先不在のため代理" });

  assert.equal(flow.aggregate.status, "IN_PROGRESS");
  assert.equal(flow.aggregate.assigneeId, "responder-d");
  assert.equal(flow.aggregate.handoffTargetId, null);
  const last = flow.events.at(-1)!;
  assert.equal(last.type, "reassigned");
  if (last.type === "reassigned") {
    assert.equal(last.data.previousAssigneeId, "responder-c");
    assert.equal(last.data.cancelledHandoffTargetId, "responder-b");
  }
});

test("escalation is an orthogonal flag with explicit clearance", () => {
  const flow = new Flow();
  flow.run({ type: "escalate", actorId: "dispatcher-a", reason: "応答なし継続" });
  assert.equal(flow.aggregate.status, "NEW");
  assert.equal(flow.aggregate.escalation?.escalatedBy, "dispatcher-a");

  assert.throws(
    () => executeCommand(flow.aggregate, flow.aggregate.version, { type: "escalate", actorId: "d", reason: "again" }, at(9)),
    InvalidTransitionError,
  );

  flow.run({ type: "clear_escalation", actorId: "supervisor-a", reason: "管理者確認済み" });
  assert.equal(flow.aggregate.escalation, null);
});

test("resolve and reopen preserve history and count", () => {
  const flow = new Flow();
  flow.run({ type: "acknowledge", actorId: "d" })
    .run({ type: "assign", actorId: "d", assigneeId: "responder-a" })
    .run({ type: "start_action", actorId: "responder-a" })
    .run({ type: "complete", actorId: "responder-a", outcome: "confirmed_safe", summary: "s", evidence: [{ kind: "call", ref: "call:1" }] })
    .run({ type: "close", actorId: "supervisor-a" })
    .run({ type: "reopen", actorId: "supervisor-a", reason: "再度の不調申告" });

  assert.equal(flow.aggregate.status, "IN_PROGRESS");
  assert.equal(flow.aggregate.reopenedCount, 1);
  assert.equal(flow.aggregate.completion, null);
  assert.equal(flow.events.filter((event) => event.type === "completed").length, 1);
});

test("duplicate signals link to an open Case without status change; closed Cases refuse links", () => {
  const flow = new Flow();
  const linked = linkSignalToCase(
    flow.aggregate,
    1,
    { sourceAdapter: "sensor", sourceSignalId: "sig-2", sourceType: "non_response", linkedBy: null },
    at(1),
  );
  assert.equal(linked.aggregate.status, "NEW");
  assert.equal(linked.aggregate.linkedSignalCount, 1);
  assert.equal(linked.event.actorId, null);

  assert.throws(
    () => linkSignalToCase(linked.aggregate, 1, { sourceAdapter: "s", sourceSignalId: "z", sourceType: "sos", linkedBy: null }, at(2)),
    CaseConflictError,
  );
});

test("notes are rejected on CLOSED Cases and require text", () => {
  const flow = new Flow();
  assert.throws(
    () => executeCommand(flow.aggregate, 1, { type: "add_note", actorId: "d", kind: "action", text: " " }, at(1)),
    InvalidTransitionError,
  );
  flow.run({ type: "acknowledge", actorId: "d" })
    .run({ type: "assign", actorId: "d", assigneeId: "r" })
    .run({ type: "start_action", actorId: "r" })
    .run({ type: "complete", actorId: "r", outcome: "other", summary: "s", evidence: [{ kind: "note", ref: "n" }] })
    .run({ type: "close", actorId: "d" });
  assert.throws(
    () => executeCommand(flow.aggregate, flow.aggregate.version, { type: "add_note", actorId: "d", kind: "action", text: "late" }, at(99)),
    InvalidTransitionError,
  );
});

test("audit trail records actor, time, before and after for every transition", () => {
  const flow = new Flow();
  flow.run({ type: "acknowledge", actorId: "dispatcher-a" })
    .run({ type: "triage", actorId: "dispatcher-a", category: "転倒", priority: "high", rationale: "r" })
    .run({ type: "assign", actorId: "supervisor-a", assigneeId: "responder-a" });

  const trail = projectCaseAuditTrail(flow.events);
  assert.equal(trail.length, 4);
  assert.equal(trail[0]!.action, "case_created");
  assert.equal(trail[0]!.actorId, "dispatcher-a");

  const triage = trail[2]!;
  assert.equal(triage.actorId, "dispatcher-a");
  assert.equal(triage.at, at(2));
  assert.deepEqual(
    triage.changes.find((change) => change.field === "priority"),
    { field: "priority", before: "normal", after: "high" },
  );
  assert.deepEqual(
    triage.changes.find((change) => change.field === "status"),
    { field: "status", before: "ACKNOWLEDGED", after: "TRIAGED" },
  );
  assert.equal(triage.versionBefore, 2);
  assert.equal(triage.versionAfter, 3);

  const assign = trail[3]!;
  assert.deepEqual(
    assign.changes.find((change) => change.field === "assigneeId"),
    { field: "assigneeId", before: null, after: "responder-a" },
  );
});
