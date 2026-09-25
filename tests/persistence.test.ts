import assert from "node:assert/strict";
import test from "node:test";

import {
  CaseConflictError,
  InMemoryCaseRepository,
  createCase,
  executeCommand,
  replayCase,
} from "../src/index.ts";

function at(minute: number): string {
  return new Date(Date.UTC(2026, 8, 25, 1, minute, 0)).toISOString();
}

test("tenant boundary isolates identical case ids", async () => {
  const repo = new InMemoryCaseRepository();

  const a = createCase({
    id: "case-shared",
    tenantId: "provider-a",
    subjectId: "subject-a",
    sourceType: "non_response",
    createdAt: at(0),
  });
  const b = createCase({
    id: "case-shared",
    tenantId: "provider-b",
    subjectId: "subject-b",
    sourceType: "sos",
    createdAt: at(0),
  });

  await repo.create(a.event);
  await repo.create(b.event);

  const storedA = await repo.load("provider-a", "case-shared");
  const storedB = await repo.load("provider-b", "case-shared");

  assert.equal(storedA?.aggregate.subjectId, "subject-a");
  assert.equal(storedB?.aggregate.subjectId, "subject-b");
  assert.equal(await repo.load("provider-c", "case-shared"), null);
});

test("compare-and-set allows only the first stale concurrent append", async () => {
  const repo = new InMemoryCaseRepository();
  const created = createCase({
    id: "case-race",
    tenantId: "provider-a",
    subjectId: "subject-race",
    sourceType: "unwell",
    createdAt: at(0),
  });
  await repo.create(created.event);

  const first = executeCommand(
    created.aggregate,
    1,
    { type: "acknowledge", actorId: "dispatcher-a" },
    at(1),
  );
  const staleSecond = executeCommand(
    created.aggregate,
    1,
    { type: "acknowledge", actorId: "dispatcher-b" },
    at(1),
  );

  await repo.append({
    tenantId: "provider-a",
    caseId: "case-race",
    expectedVersion: 1,
    event: first.event,
  });

  await assert.rejects(
    repo.append({
      tenantId: "provider-a",
      caseId: "case-race",
      expectedVersion: 1,
      event: staleSecond.event,
    }),
    CaseConflictError,
  );

  const stored = await repo.load("provider-a", "case-race");
  assert.equal(stored?.aggregate.version, 2);
  assert.equal(stored?.events.length, 2);
});

test("snapshot and append-only stream remain replay-equivalent", async () => {
  const repo = new InMemoryCaseRepository();
  const created = createCase({
    id: "case-replay",
    tenantId: "provider-a",
    subjectId: "subject-replay",
    sourceType: "manual",
    createdAt: at(0),
  });
  await repo.create(created.event);

  const acknowledged = executeCommand(
    created.aggregate,
    1,
    { type: "acknowledge", actorId: "dispatcher" },
    at(1),
  );
  await repo.append({
    tenantId: "provider-a",
    caseId: "case-replay",
    expectedVersion: 1,
    event: acknowledged.event,
  });

  const assigned = executeCommand(
    acknowledged.aggregate,
    2,
    { type: "assign", actorId: "dispatcher", assigneeId: "responder-a" },
    at(2),
  );
  await repo.append({
    tenantId: "provider-a",
    caseId: "case-replay",
    expectedVersion: 2,
    event: assigned.event,
  });

  const stored = await repo.load("provider-a", "case-replay");
  assert.ok(stored);
  assert.deepEqual(replayCase(stored.events), stored.aggregate);
  assert.equal(stored.aggregate.tenantId, "provider-a");
});
