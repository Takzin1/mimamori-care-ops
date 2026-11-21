import assert from "node:assert/strict";
import test from "node:test";
import { createCase, executeCommand } from "../src/core/index.ts";
import type { CaseCommand, CaseEvent } from "../src/core/types.ts";
import type { StoredCase } from "../src/persistence/types.ts";
import {
  createAuditCheckpoint, verifyAuditCheckpoint,
  type AuditCheckpointOptions, type AuditCheckpoint,
} from "../src/ops/audit-checkpoint.ts";

const time = (minute: number) => new Date(Date.UTC(2026, 10, 21, 6, minute)).toISOString();

async function options(
  fill: number = 0x34,
): Promise<AuditCheckpointOptions> {
  const bytes = new Uint8Array(32).fill(fill);
  const key = await crypto.subtle.importKey(
    "raw", bytes, { name: "HMAC", hash: "SHA-256" },
    false, ["sign", "verify"],
  );
  assert.equal(key.extractable, false);
  return {
    tenantId: "synthetic-facility-a",
    checkpointId: "synthetic-2026-11-21-1",
    keyId: "synthetic-key-v1",
    key,
  };
}

function fixture(id: string): StoredCase {
  const made = createCase({
    id, tenantId: "synthetic-facility-a", subjectId: "synthetic-private-person",
    sourceAdapter: "manual", sourceSignalId: "signal-" + id,
    sourceType: "manual", priority: "normal", createdAt: time(0),
  });
  return { aggregate: made.aggregate, events: [made.event] };
}

function updated(stored: StoredCase, command: CaseCommand, minute: number): StoredCase {
  const next = executeCommand(stored.aggregate, stored.aggregate.version, command, time(minute));
  return { aggregate: next.aggregate, events: [...stored.events, next.event] };
}

function clone(stored: StoredCase): StoredCase {
  return structuredClone(stored);
}

test("sealed checkpoint contains no tenant/Case/patient plaintext and verifies same history", async () => {
  const settings = await options();
  const cases = [fixture("case-A"), fixture("case-B")];
  const anchor = await createAuditCheckpoint(cases, settings);
  assert.equal(anchor.schema, "mimamori.audit-checkpoint.v1");
  assert.equal(anchor.caseCount, 2);
  assert.equal(anchor.cases.length, 2);
  for (const stamp of anchor.cases) {
    assert.match(stamp.caseTag, /^[0-9a-f]{64}$/);
    assert.match(stamp.eventMac, /^[0-9a-f]{64}$/);
    assert.equal(stamp.version, 1);
  }
  assert.match(anchor.signature, /^[0-9a-f]{64}$/);
  const exported = JSON.stringify(anchor);
  for (const sensitive of ["case-A", "case-B", "synthetic-facility-a",
    "synthetic-private-person", "signal-case-A"]) {
    assert.equal(exported.includes(sensitive), false);
  }
  assert.equal(await verifyAuditCheckpoint(cases, anchor, settings), true);
  assert.equal(await verifyAuditCheckpoint([...cases].reverse(), anchor, settings), true);
});

test("subsequent legitimate Case events do not invalidate earlier signed prefix", async () => {
  const settings = await options();
  const initial = fixture("case-A");
  const checkpoint = await createAuditCheckpoint([initial], settings);
  const after = updated(initial, { type: "acknowledge", actorId: "dispatcher" }, 1);
  assert.equal(after.events.length, 2);
  assert.equal(await verifyAuditCheckpoint([after], checkpoint, settings), true);
});

test("tampering with original event including a matching new snapshot is detected", async () => {
  const settings = await options();
  const initial = fixture("case-A");
  const anchor = await createAuditCheckpoint([initial], settings);
  const modified = clone(initial);
  const origin = modified.events[0];
  assert.equal(origin?.type, "case_created");
  if (origin?.type !== "case_created") return;
  origin.data.subjectId = "attacker-subject";
  modified.aggregate.subjectId = "attacker-subject";
  assert.equal(await verifyAuditCheckpoint([modified], anchor, settings), false);
  assert.equal(await verifyAuditCheckpoint([], anchor, settings), false);
});

test("malformed history and missing events fail closed; new future events are tolerated", async () => {
  const settings = await options();
  const starting = fixture("case-A");
  const after = updated(starting, { type: "acknowledge", actorId: "dispatcher" }, 1);
  const anchor = await createAuditCheckpoint([after], settings);
  assert.equal(await verifyAuditCheckpoint([starting], anchor, settings), false);
  const corrupt = clone(after);
  corrupt.events = [corrupt.events[0]!, { ...corrupt.events[1]!, sequence: 9 } as CaseEvent];
  assert.equal(await verifyAuditCheckpoint([corrupt], anchor, settings), false);
  const newCase = fixture("case-C");
  assert.equal(await verifyAuditCheckpoint([after, newCase], anchor, settings), true);
});

test("wrong key, mismatched scope, altered manifest and replayed label fail verification", async () => {
  const settings = await options();
  const data = [fixture("case-A")];
  const anchor = await createAuditCheckpoint(data, settings);
  assert.equal(await verifyAuditCheckpoint(data, anchor, await options(0x35)), false);
  assert.equal(await verifyAuditCheckpoint(data, anchor, { ...settings, tenantId: "other-tenant" }), false);
  assert.equal(await verifyAuditCheckpoint(data, anchor, { ...settings, checkpointId: "other-checkpoint" }), false);
  assert.equal(await verifyAuditCheckpoint(data, { ...anchor, caseCount: 0 }, settings), false);
  assert.equal(await verifyAuditCheckpoint(data, { ...anchor, signature: "a".repeat(64) }, settings), false);
  const forged: AuditCheckpoint = structuredClone(anchor);
  forged.cases[0]!.eventMac = "f".repeat(64);
  assert.equal(await verifyAuditCheckpoint(data, forged, settings), false);
});

test("duplicate Case IDs and snapshot/event divergence never become valid anchors", async () => {
  const settings = await options();
  const one = fixture("case-A");
  await assert.rejects(createAuditCheckpoint([one, one], settings), /Duplicate Case/);
  const broken = clone(one);
  broken.aggregate.status = "COMPLETED";
  await assert.rejects(createAuditCheckpoint([broken], settings), /snapshot mismatch/);
  const anchor = await createAuditCheckpoint([one], settings);
  assert.equal(await verifyAuditCheckpoint([one, one], anchor, settings), false);
  assert.equal(await verifyAuditCheckpoint([broken], anchor, settings), false);
});
