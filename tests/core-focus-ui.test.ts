import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createCase, executeCommand, replayCase, InvalidTransitionError,
  selectPrimaryCoreAction, explainCaseStage, explainPriority,
} from "../src/index.ts";
import type { ConsoleWebAction } from "../src/console-web/types.ts";
import type { CaseStatus } from "../src/core/types.ts";

const action = (type: ConsoleWebAction["type"]): ConsoleWebAction =>
  ({ type, label: type, requires: [] });

test("Core UI selects one primary action only from server capabilities", () => {
  const examples: Array<[CaseStatus, ConsoleWebAction["type"], ConsoleWebAction["type"]]> = [
    ["NEW", "acknowledge", "set_priority"],
    ["ACKNOWLEDGED", "assign", "set_priority"],
    ["ASSIGNED", "start_action", "set_priority"],
    ["IN_PROGRESS", "complete", "request_handoff"],
    ["HANDOFF_PENDING", "accept_handoff", "set_priority"],
    ["COMPLETED", "close", "reopen"],
  ];
  for (const [status, target, optional] of examples) {
    const permitted = [action(optional), action(target)];
    const primary = selectPrimaryCoreAction(status, permitted);
    assert.strictEqual(primary, permitted[1], `${status}: must reuse allowed object`);
  }
  assert.equal(selectPrimaryCoreAction("NEW", []), null);
  assert.equal(selectPrimaryCoreAction("HANDOFF_PENDING", [action("set_priority")]), null);
  assert.equal(selectPrimaryCoreAction("IN_PROGRESS", [action("request_handoff")])?.type, "request_handoff");
  assert.equal(selectPrimaryCoreAction("CLOSED", [action("reopen")]), null);
  assert.equal(explainCaseStage("HANDOFF_PENDING"), "引き継ぎ先の受諾待ち");
  assert.equal(explainPriority("high"), "高");
});

test("golden Case lifecycle: no responsibility gap and no evidence-free completion", () => {
  const opened = createCase({
    id: "synthetic-case", tenantId: "care-facility", subjectId: "synthetic-resident",
    sourceType: "manual", sourceAdapter: "staff-manual",
    sourceSignalId: "synthetic-signal", priority: "normal",
    createdAt: "2026-11-21T03:00:00.000Z",
  });
  const events = [opened.event];
  let current = opened.aggregate;
  const execute = (command: Parameters<typeof executeCommand>[2]) => {
    const result = executeCommand(current, current.version, command, "2026-11-21T03:01:00.000Z");
    current = result.aggregate;
    events.push(result.event as never);
  };
  execute({ type: "acknowledge", actorId: "dispatcher" });
  execute({ type: "assign", actorId: "dispatcher", assigneeId: "staff-a" });
  execute({ type: "start_action", actorId: "staff-a" });
  execute({ type: "request_handoff", actorId: "staff-a", targetAssigneeId: "staff-b" });
  assert.equal(current.status, "HANDOFF_PENDING");
  assert.equal(current.assigneeId, "staff-a", "old owner must remain responsible");
  assert.equal(current.handoffTargetId, "staff-b");
  assert.throws(() => executeCommand(current, current.version,
    { type: "complete", actorId: "staff-a", outcome: "visit_completed",
      summary: "synthetic", evidence: [{ kind: "note", ref: "synthetic:proof" }] },
    "2026-11-21T03:02:00Z"), InvalidTransitionError);
  assert.throws(() => executeCommand(current, current.version,
    { type: "accept_handoff", actorId: "staff-a" },
    "2026-11-21T03:02:00Z"), InvalidTransitionError);

  execute({ type: "accept_handoff", actorId: "staff-b" });
  assert.equal(current.status, "IN_PROGRESS");
  assert.equal(current.assigneeId, "staff-b");
  assert.equal(current.handoffTargetId, null);
  assert.throws(() => executeCommand(current, current.version,
    { type: "complete", actorId: "staff-b",
      outcome: "visit_completed", summary: "synthetic", evidence: [] },
    "2026-11-21T03:03:00Z"), InvalidTransitionError);
  execute({ type: "complete", actorId: "staff-b", outcome: "visit_completed",
    summary: "synthetic visit completed", evidence: [{ kind: "note", ref: "synthetic:visit:1" }] });
  assert.equal(current.status, "COMPLETED");
  assert.equal(current.completion?.completedBy, "staff-b");
  assert.equal(current.completion?.evidence.length, 1);
  execute({ type: "close", actorId: "supervisor" });
  assert.equal(current.status, "CLOSED");
  assert.deepEqual(replayCase(events), current);
});

test("minimal renderer keeps optional actions and full timeline behind disclosure", async () => {
  const source = await readFile(new URL("../src/console-web/renderer.ts", import.meta.url), "utf8");
  assert.match(source, /selectPrimaryCoreAction\(model\.selected\.status, model\.actions\)/);
  assert.match(source, /const secondary = model\.actions\.filter/);
  assert.match(source, /mco-secondary-actions/);
  assert.match(source, /対応履歴・詳細を見る/);
  assert.match(source, /explainCaseEvent/);
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|localStorage|sessionStorage/);
});
