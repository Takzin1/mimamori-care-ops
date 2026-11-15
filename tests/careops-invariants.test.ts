import assert from "node:assert/strict";
import test from "node:test";

import {
  CASE_COMMAND_TYPES,
  CASE_PRIORITIES,
  InvalidTransitionError,
  canCaseCommand,
  createCase,
  executeCommand,
  linkSignalToCase,
  replayCase,
  type CaseAggregate,
  type CaseCommand,
  type CaseCommandType,
  type CaseEvent,
} from "../src/index.ts";

/**
 * Model-based check of the Case state machine: thousands of random
 * command sequences (valid and invalid, right and wrong actors) and after
 * every step the structural invariants must hold. Synthetic data only.
 */

function prng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const ACTORS = ["disp", "resp-a", "resp-b", "resp-c", "sup"];

function randomCommand(type: CaseCommandType, actorId: string, pick: <T>(items: readonly T[]) => T): CaseCommand {
  switch (type) {
    case "acknowledge": case "start_action": case "accept_handoff": case "close":
      return { type, actorId };
    case "set_priority":
      return { type, actorId, priority: pick(CASE_PRIORITIES), rationale: "synthetic" };
    case "triage":
      return { type, actorId, category: "synthetic", priority: pick(CASE_PRIORITIES), rationale: "synthetic" };
    case "assign": case "reassign":
      return type === "assign"
        ? { type, actorId, assigneeId: pick(ACTORS) }
        : { type, actorId, assigneeId: pick(ACTORS), reason: "synthetic" };
    case "add_note":
      return { type, actorId, kind: pick(["observation", "action", "contact", "other"] as const), text: "synthetic", evidence: pick([undefined, [{ kind: "call" as const, ref: "call:synthetic" }]]) };
    case "escalate": case "clear_escalation": case "decline_handoff": case "cancel_handoff": case "reopen":
      return { type, actorId, reason: "synthetic" };
    case "request_handoff":
      return { type, actorId, targetAssigneeId: pick(ACTORS), note: pick([undefined, "synthetic"]) };
    case "complete":
      return { type, actorId, outcome: "confirmed_safe", summary: "synthetic", evidence: pick([[], [{ kind: "visit" as const, ref: "visit:synthetic" }]]) };
  }
}

function assertInvariants(aggregate: CaseAggregate, events: readonly CaseEvent[], created: CaseAggregate): void {
  const context = `${aggregate.status} v${aggregate.version} after ${events.at(-1)!.type}`;
  assert.equal(aggregate.version, events.length, `version equals event count (${context})`);
  events.forEach((event, index) => assert.equal(event.sequence, index + 1, "contiguous sequence"));
  assert.deepEqual(replayCase(events), aggregate, `replay equals aggregate (${context})`);
  assert.deepEqual(replayCase(JSON.parse(JSON.stringify(events))), JSON.parse(JSON.stringify(aggregate)), "JSON round-trip replay");

  // immutable lineage
  for (const key of ["id", "tenantId", "facilityId", "subjectId", "sourceAdapter", "sourceSignalId", "sourceType", "createdAt", "createdBy"] as const) {
    assert.deepEqual(aggregate[key], created[key], `${key} is immutable`);
  }

  // ownership
  const owned = ["ASSIGNED", "IN_PROGRESS", "HANDOFF_PENDING"].includes(aggregate.status);
  if (owned) assert.ok(aggregate.assigneeId, `owned status has an assignee (${context})`);
  if (["NEW", "ACKNOWLEDGED", "TRIAGED"].includes(aggregate.status)) {
    assert.equal(aggregate.assigneeId, null, `pre-assignment status has no assignee (${context})`);
  }
  if (aggregate.status === "HANDOFF_PENDING") {
    assert.ok(aggregate.handoffTargetId, "pending handoff has a target");
    assert.notEqual(aggregate.handoffTargetId, aggregate.assigneeId, "handoff target differs from the accountable assignee");
    assert.ok(aggregate.handoffRequestedAt, "pending handoff has a request time");
  } else {
    assert.equal(aggregate.handoffTargetId, null, `no handoff target outside HANDOFF_PENDING (${context})`);
    assert.equal(aggregate.handoffNote, null, "no dangling handoff note");
    assert.equal(aggregate.handoffRequestedAt, null, "no dangling handoff request time");
  }

  // completion and closure
  const resolved = aggregate.status === "COMPLETED" || aggregate.status === "CLOSED";
  assert.equal(aggregate.completion !== null, resolved, `completion record iff resolved (${context})`);
  assert.equal(aggregate.completedAt !== null, resolved, "completedAt iff resolved");
  assert.equal(aggregate.closedAt !== null, aggregate.status === "CLOSED", "closedAt iff CLOSED");
  if (aggregate.completion) {
    assert.ok(aggregate.completion.evidence.length >= 1, "resolution always carries evidence");
    assert.ok(aggregate.completion.completedBy, "resolution has an accountable resolver");
  }
  if (aggregate.status === "CLOSED") {
    assert.equal(aggregate.escalation, null, "a Case cannot be closed while escalated");
  }

  // derived counters and clocks
  assert.equal(aggregate.reopenedCount, events.filter((event) => event.type === "reopened").length);
  assert.equal(aggregate.linkedSignalCount, events.filter((event) => event.type === "signal_linked").length);
  assert.equal(aggregate.lastActivityAt, events.at(-1)!.at, "lastActivityAt follows the last event");
  if (aggregate.status !== "NEW") assert.ok(aggregate.acknowledgedAt, "acknowledgedAt set once past NEW");
  assert.equal(aggregate.triagedAt !== null, events.some((event) => event.type === "triaged"));
  assert.equal(
    Boolean(aggregate.escalation),
    (() => {
      let active = false;
      for (const event of events) {
        if (event.type === "escalated") active = true;
        if (event.type === "escalation_cleared") active = false;
      }
      return active;
    })(),
    "escalation flag follows escalate / clear events",
  );

  // every human-attributable event has an actor
  for (const event of events) {
    if (event.type !== "case_created" && event.type !== "signal_linked") {
      assert.ok(event.actorId, `${event.type} has an accountable actor`);
    }
  }
}

test("state machine invariants hold for random command sequences", () => {
  const random = prng(0xC0FFEE);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const reached = new Set<string>();
  const applied = new Map<string, number>();
  let rejected = 0;

  for (let run = 0; run < 400; run += 1) {
    const created = createCase({
      id: `case-${run}`,
      tenantId: "tenant-inv",
      ...(random() < 0.8 ? { facilityId: pick(["fac-a", "fac-b"]) } : {}),
      subjectId: `resident-ref-${run % 7}`,
      sourceType: pick(["unwell", "sos", "non_response", "manual"] as const),
      sourceAdapter: "synthetic",
      sourceSignalId: `sig-${run}`,
      priority: pick(CASE_PRIORITIES),
      createdAt: new Date(Date.UTC(2026, 10, 1, 0, run)).toISOString(),
      ...(random() < 0.5 ? { createdBy: pick(ACTORS) } : {}),
    });
    let aggregate = created.aggregate;
    const events: CaseEvent[] = [created.event];
    let minute = 0;
    assertInvariants(aggregate, events, created.aggregate);

    for (let step = 0; step < 30; step += 1) {
      minute += 1;
      const at = new Date(Date.parse(aggregate.createdAt) + minute * 60_000).toISOString();
      const before = structuredClone(aggregate);

      if (random() < 0.05) {
        try {
          const linked = linkSignalToCase(aggregate, aggregate.version, { sourceAdapter: "synthetic", sourceSignalId: `dup-${run}-${step}`, sourceType: "unwell", linkedBy: null }, at);
          aggregate = linked.aggregate;
          events.push(linked.event);
        } catch (error) {
          assert.ok(error instanceof InvalidTransitionError);
        }
      } else {
        const type = pick(CASE_COMMAND_TYPES);
        // Bias towards the actor who could plausibly act, but also try others.
        const actorId = random() < 0.7
          ? (["accept_handoff", "decline_handoff"].includes(type) ? aggregate.handoffTargetId : aggregate.assigneeId) ?? pick(ACTORS)
          : pick(ACTORS);
        const command = randomCommand(type, actorId, pick);
        const allowed = canCaseCommand(aggregate, actorId, type);
        try {
          const result = executeCommand(aggregate, aggregate.version, command, at);
          assert.ok(allowed, `executed command must have been advertised as available: ${type} from ${before.status}`);
          aggregate = result.aggregate;
          events.push(result.event);
          applied.set(type, (applied.get(type) ?? 0) + 1);
        } catch (error) {
          assert.ok(error instanceof InvalidTransitionError, `unexpected error type for ${type}: ${error}`);
          assert.deepEqual(aggregate, before, "a rejected command leaves the aggregate untouched");
          rejected += 1;
        }
      }
      reached.add(aggregate.status);
      assertInvariants(aggregate, events, created.aggregate);
    }
  }

  // The walk must actually exercise the whole machine.
  for (const status of ["NEW", "ACKNOWLEDGED", "TRIAGED", "ASSIGNED", "IN_PROGRESS", "HANDOFF_PENDING", "COMPLETED", "CLOSED"]) {
    assert.ok(reached.has(status), `random walk reached ${status}`);
  }
  for (const type of CASE_COMMAND_TYPES) {
    assert.ok((applied.get(type) ?? 0) > 0, `random walk applied ${type}`);
  }
  assert.ok(rejected > 1000, "invalid commands were attempted and rejected");
});

test("an escalated Case cannot be closed until a human clears the escalation", () => {
  let { aggregate } = createCase({ id: "c", tenantId: "t", subjectId: "s", sourceType: "manual", sourceAdapter: "a", sourceSignalId: "x", priority: "high", createdAt: "2026-11-01T00:00:00.000Z" });
  const run = (command: CaseCommand, minute: number) => {
    aggregate = executeCommand(aggregate, aggregate.version, command, `2026-11-01T00:${String(minute).padStart(2, "0")}:00.000Z`).aggregate;
  };
  run({ type: "acknowledge", actorId: "d" }, 1);
  run({ type: "assign", actorId: "d", assigneeId: "r" }, 2);
  run({ type: "start_action", actorId: "r" }, 3);
  run({ type: "escalate", actorId: "r", reason: "改善なし" }, 4);
  run({ type: "complete", actorId: "r", outcome: "confirmed_safe", summary: "s", evidence: [{ kind: "visit", ref: "v" }] }, 5);
  assert.equal(canCaseCommand(aggregate, "d", "close"), false);
  assert.throws(() => executeCommand(aggregate, aggregate.version, { type: "close", actorId: "d" }, "2026-11-01T00:06:00.000Z"), InvalidTransitionError);
  run({ type: "clear_escalation", actorId: "s", reason: "管理者確認済み" }, 7);
  run({ type: "close", actorId: "d" }, 8);
  assert.equal(aggregate.status, "CLOSED");
});

test("action history entries can carry evidence references", () => {
  const { aggregate } = createCase({ id: "c", tenantId: "t", subjectId: "s", sourceType: "manual", sourceAdapter: "a", sourceSignalId: "x", priority: "low", createdAt: "2026-11-01T00:00:00.000Z" });
  const noted = executeCommand(aggregate, 1, { type: "add_note", actorId: "d", kind: "contact", text: "家族へ電話、不在", evidence: [{ kind: "call", ref: "call-log:synthetic-1" }] }, "2026-11-01T00:01:00.000Z");
  assert.equal(noted.event.type, "note_added");
  if (noted.event.type === "note_added") assert.deepEqual(noted.event.data.evidence, [{ kind: "call", ref: "call-log:synthetic-1" }]);
  const plain = executeCommand(aggregate, 1, { type: "add_note", actorId: "d", kind: "other", text: "x" }, "2026-11-01T00:01:00.000Z");
  assert.equal("evidence" in plain.event.data, false, "no evidence key when none supplied");
  assert.throws(() => executeCommand(aggregate, 1, { type: "add_note", actorId: "d", kind: "other", text: "x", evidence: [{ kind: "call", ref: " " }] }, "2026-11-01T00:01:00.000Z"), InvalidTransitionError);
  assert.throws(() => executeCommand(aggregate, 1, { type: "add_note", actorId: "d", kind: "other", text: "x", evidence: Array.from({ length: 11 }, () => ({ kind: "note" as const, ref: "n" })) }, "2026-11-01T00:01:00.000Z"), InvalidTransitionError);
});
