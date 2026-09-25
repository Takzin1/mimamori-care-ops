import assert from "node:assert/strict";
import test from "node:test";

import {
  CaseService,
  InMemoryCaseRepository,
} from "../src/index.ts";

function at(minute: number): string {
  return new Date(Date.UTC(2026, 8, 25, 2, minute, 0)).toISOString();
}

test("application service drives the full GK last-mile lifecycle", async () => {
  const times = [
    at(0),
    at(2),
    at(4),
    at(5),
    at(8),
    at(10),
    at(20),
    at(22),
  ];
  let tick = 0;

  const service = new CaseService(
    new InMemoryCaseRepository(),
    () => times[tick++] ?? at(99),
  );

  let result = await service.openFromSignal(
    {
      id: "signal-001",
      tenantId: "provider-a",
      subjectId: "subject-001",
      type: "non_response",
    },
    "case-001",
  );

  assert.equal(result.aggregate.status, "NEW");
  assert.equal(result.aggregate.version, 1);

  result = await service.execute({
    tenantId: "provider-a",
    caseId: "case-001",
    expectedVersion: 1,
    command: { type: "acknowledge", actorId: "dispatcher" },
  });

  result = await service.execute({
    tenantId: "provider-a",
    caseId: "case-001",
    expectedVersion: 2,
    command: {
      type: "assign",
      actorId: "dispatcher",
      assigneeId: "responder-a",
    },
  });

  result = await service.execute({
    tenantId: "provider-a",
    caseId: "case-001",
    expectedVersion: 3,
    command: { type: "start_action", actorId: "responder-a" },
  });

  result = await service.execute({
    tenantId: "provider-a",
    caseId: "case-001",
    expectedVersion: 4,
    command: {
      type: "request_handoff",
      actorId: "responder-a",
      targetAssigneeId: "responder-b",
    },
  });

  assert.equal(result.aggregate.status, "HANDOFF_PENDING");
  assert.equal(result.aggregate.assigneeId, "responder-a");
  assert.equal(result.aggregate.handoffTargetId, "responder-b");

  result = await service.execute({
    tenantId: "provider-a",
    caseId: "case-001",
    expectedVersion: 5,
    command: { type: "accept_handoff", actorId: "responder-b" },
  });

  result = await service.execute({
    tenantId: "provider-a",
    caseId: "case-001",
    expectedVersion: 6,
    command: {
      type: "complete",
      actorId: "responder-b",
      outcome: "confirmed_safe",
      summary: "電話で本人の安全を確認",
      evidence: [{ kind: "call", ref: "call:001" }],
    },
  });

  assert.equal(result.aggregate.status, "COMPLETED");
  assert.equal(result.aggregate.completion?.completedBy, "responder-b");

  result = await service.execute({
    tenantId: "provider-a",
    caseId: "case-001",
    expectedVersion: 7,
    command: { type: "close", actorId: "supervisor" },
  });

  assert.equal(result.aggregate.status, "CLOSED");

  const metrics = await service.metrics("provider-a", "case-001");
  assert.equal(metrics.timeToAcknowledgeMs, 2 * 60_000);
  assert.equal(metrics.timeToAssignmentMs, 4 * 60_000);
  assert.equal(metrics.timeToFirstActionMs, 5 * 60_000);
  assert.equal(metrics.timeToCompletionMs, 20 * 60_000);
  assert.equal(metrics.handoffCount, 1);

  assert.equal(
    await service.get("provider-b", "case-001"),
    null,
    "wrong tenant must not observe the case",
  );
});
