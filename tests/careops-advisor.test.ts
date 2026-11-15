import assert from "node:assert/strict";
import test from "node:test";

import {
  ADVISOR_ENGINE,
  CASE_COMMAND_TYPES,
  CASE_PRIORITIES,
  PROVISIONAL_SLA_POLICY,
  adviseCase,
  canCaseCommand,
  clinicalAssertionWarnings,
  createCase,
  evaluateCaseSla,
  executeCommand,
  projectCaseCapabilities,
  type CaseAggregate,
  type CaseCommand,
  type CaseEvent,
  type StaffRole,
} from "../src/index.ts";

const T0 = Date.parse("2026-11-10T00:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

class Flow {
  aggregate: CaseAggregate;
  events: CaseEvent[];
  minute = 0;
  constructor(priority: (typeof CASE_PRIORITIES)[number] = "high") {
    const created = createCase({ id: "case-adv", tenantId: "t", facilityId: "fac-a", subjectId: "resident-ref-1", sourceType: "unwell", sourceAdapter: "phone", sourceSignalId: "s1", priority, createdAt: at(0) });
    this.aggregate = created.aggregate;
    this.events = [created.event];
  }
  run(command: CaseCommand, advance = 1): this {
    this.minute += advance;
    const result = executeCommand(this.aggregate, this.aggregate.version, command, at(this.minute));
    this.aggregate = result.aggregate;
    this.events.push(result.event);
    return this;
  }
  advise(viewer: { actorId: string; roles: StaffRole[] }, options: { nowMinute?: number; ownership?: { assigneeUnavailable: boolean; handoffTargetUnavailable: boolean }; pendingDraftCount?: number } = {}) {
    const now = at(options.nowMinute ?? this.minute);
    return adviseCase({
      aggregate: this.aggregate,
      events: this.events,
      sla: evaluateCaseSla(this.aggregate, this.events, PROVISIONAL_SLA_POLICY, now),
      capabilities: projectCaseCapabilities(this.aggregate, { tenantId: "t", principalId: "p", actorId: viewer.actorId, roles: viewer.roles, active: true }),
      ownership: options.ownership ?? { assigneeUnavailable: false, handoffTargetUnavailable: false },
      pendingDraftCount: options.pendingDraftCount ?? 0,
      slaApproved: false,
      now,
    });
  }
}

const ids = (advice: ReturnType<Flow["advise"]>) => advice.candidates.map((candidate) => candidate.id);
const dispatcher = { actorId: "disp", roles: ["dispatcher"] as StaffRole[] };
const supervisor = { actorId: "sup", roles: ["supervisor"] as StaffRole[] };
const responder = (actorId: string) => ({ actorId, roles: ["responder"] as StaffRole[] });

test("candidates follow the recorded state and the viewer's permissions", () => {
  const flow = new Flow("critical");
  let advice = flow.advise(dispatcher);
  assert.deepEqual(advice.generatedBy, ADVISOR_ENGINE);
  assert.deepEqual(ids(advice), ["acknowledge"]);
  assert.equal(advice.candidates[0]!.executableByViewer, true);
  assert.equal(advice.candidates[0]!.attention, true);
  assert.equal(flow.advise(responder("resp-a")).candidates[0]!.executableByViewer, false, "responders cannot acknowledge");
  assert.deepEqual(flow.advise(responder("resp-a")).candidates[0]!.requiredRoles, ["dispatcher", "supervisor"]);

  flow.run({ type: "acknowledge", actorId: "disp" });
  assert.deepEqual(ids(flow.advise(dispatcher)), ["triage", "assign"]);
  flow.run({ type: "triage", actorId: "disp", category: "体調不良", priority: "high", rationale: "合成" });
  assert.deepEqual(ids(flow.advise(dispatcher)), ["assign"]);
  flow.run({ type: "assign", actorId: "disp", assigneeId: "resp-a" });
  assert.deepEqual(ids(flow.advise(responder("resp-a"))), ["start_action"]);

  // first-action target exceeded → check on the assignee / consider reassigning
  advice = flow.advise(supervisor, { nowMinute: flow.minute + 45 });
  assert.deepEqual(ids(advice), ["start_action", "reassign_no_start"]);
  assert.ok(advice.candidates.every((candidate) => candidate.attention));
  assert.equal(advice.candidates.find((candidate) => candidate.id === "reassign_no_start")!.executableByViewer, true);

  flow.run({ type: "start_action", actorId: "resp-a" });
  assert.deepEqual(ids(flow.advise(responder("resp-a"))), ["record_observation", "complete", "request_handoff"]);
  flow.run({ type: "add_note", actorId: "resp-a", kind: "observation", text: "訪問。会話可能。", evidence: [{ kind: "visit", ref: "visit:1" }] });
  advice = flow.advise(responder("resp-a"));
  assert.deepEqual(ids(advice), ["complete", "request_handoff"]);
  assert.equal(advice.situation.find((fact) => fact.key === "evidence")!.value, "1件");

  flow.run({ type: "request_handoff", actorId: "resp-a", targetAssigneeId: "resp-b", note: "申し送り" });
  assert.deepEqual(ids(flow.advise(responder("resp-b"))), ["accept_handoff"]);
  assert.equal(flow.advise(responder("resp-a")).candidates[0]!.executableByViewer, false, "only the target can accept");
  assert.deepEqual(ids(flow.advise(supervisor, { nowMinute: flow.minute + 40 })), ["accept_handoff", "reassign_unaccepted"]);

  flow.run({ type: "accept_handoff", actorId: "resp-b" });
  flow.run({ type: "escalate", actorId: "resp-b", reason: "改善なし" });
  assert.ok(ids(flow.advise(supervisor)).includes("review_escalation"));
  flow.run({ type: "complete", actorId: "resp-b", outcome: "confirmed_safe", summary: "改善", evidence: [{ kind: "visit", ref: "visit:2" }] });
  assert.deepEqual(ids(flow.advise(supervisor)), ["clear_escalation_before_close"], "closing is not offered while escalated");
  flow.run({ type: "clear_escalation", actorId: "sup", reason: "確認済み" });
  assert.deepEqual(ids(flow.advise(dispatcher)), ["close"]);
  flow.run({ type: "close", actorId: "disp" });
  assert.deepEqual(ids(flow.advise(supervisor)), []);
});

test("unavailable owners are always listed first", () => {
  const flow = new Flow();
  flow.run({ type: "acknowledge", actorId: "disp" }).run({ type: "assign", actorId: "disp", assigneeId: "resp-a" });
  let advice = flow.advise(supervisor, { ownership: { assigneeUnavailable: true, handoffTargetUnavailable: false } });
  assert.deepEqual(ids(advice), ["reassign_unavailable_assignee"], "starting the action is not suggested to someone who cannot act");
  flow.run({ type: "reassign", actorId: "sup", assigneeId: "resp-b", reason: "退職" }).run({ type: "start_action", actorId: "resp-b" })
    .run({ type: "request_handoff", actorId: "resp-b", targetAssigneeId: "resp-c" });
  advice = flow.advise(responder("resp-b"), { ownership: { assigneeUnavailable: false, handoffTargetUnavailable: true } });
  assert.deepEqual(ids(advice), ["cancel_handoff_unavailable_target", "reassign_unavailable_target"]);
  assert.equal(advice.candidates[0]!.executableByViewer, true, "the accountable assignee can cancel");
  assert.equal(advice.candidates[1]!.executableByViewer, false, "responders cannot reassign");
});

test("informational candidates carry no command", () => {
  const flow = new Flow();
  const advice = flow.advise(dispatcher, { pendingDraftCount: 2 });
  const drafts = advice.candidates.find((candidate) => candidate.id === "review_ai_drafts")!;
  assert.equal(drafts.command, null);
  assert.equal(drafts.executableByViewer, false);
  assert.equal(advice.situation.find((fact) => fact.key === "pendingDrafts")!.value, "2件");
});

test("advisor never proposes a priority, a diagnosis, or anything outside existing commands (fuzzed states)", () => {
  let seed = 4242;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const actors = ["disp", "resp-a", "resp-b", "sup"];
  const viewers = [dispatcher, supervisor, responder("resp-a"), responder("resp-b"), { actorId: "aud", roles: ["auditor"] as StaffRole[] }];
  const texts = new Set<string>();
  let checked = 0;

  for (let run = 0; run < 150; run += 1) {
    const flow = new Flow(pick(CASE_PRIORITIES));
    for (let step = 0; step < 14; step += 1) {
      const type = pick(CASE_COMMAND_TYPES);
      const actorId = (["accept_handoff", "decline_handoff"].includes(type) ? flow.aggregate.handoffTargetId : flow.aggregate.assigneeId) ?? pick(actors);
      if (!canCaseCommand(flow.aggregate, actorId, type)) continue;
      const command = ((): CaseCommand | null => {
        switch (type) {
          case "acknowledge": case "start_action": case "accept_handoff": case "close": return { type, actorId };
          case "set_priority": { const priority = pick(CASE_PRIORITIES); return priority === flow.aggregate.priority ? null : { type, actorId, priority }; }
          case "triage": return { type, actorId, category: "合成", priority: pick(CASE_PRIORITIES), rationale: "合成" };
          case "assign": return { type, actorId, assigneeId: pick(["resp-a", "resp-b"]) };
          case "reassign": { const next = pick(["resp-a", "resp-b", "sup"]); return next === flow.aggregate.assigneeId ? null : { type, actorId, assigneeId: next, reason: "合成" }; }
          case "add_note": return { type, actorId, kind: pick(["observation", "action"] as const), text: "合成" };
          case "request_handoff": { const target = pick(["resp-a", "resp-b", "sup"]); return target === actorId ? null : { type, actorId, targetAssigneeId: target }; }
          case "complete": return { type, actorId, outcome: "confirmed_safe", summary: "合成", evidence: [{ kind: "note", ref: "n" }] };
          default: return { type, actorId, reason: "合成" } as CaseCommand;
        }
      })();
      if (!command) continue;
      flow.run(command, 1 + Math.floor(random() * 40));

      for (const viewer of viewers) {
        const advice = flow.advise(viewer, {
          nowMinute: flow.minute + Math.floor(random() * 120),
          ownership: { assigneeUnavailable: random() < 0.1 && Boolean(flow.aggregate.assigneeId), handoffTargetUnavailable: random() < 0.1 && Boolean(flow.aggregate.handoffTargetId) },
        });
        const capabilities = new Set(projectCaseCapabilities(flow.aggregate, { tenantId: "t", principalId: "p", actorId: viewer.actorId, roles: viewer.roles, active: true }).commands.map((item) => item.type));
        for (const candidate of advice.candidates) {
          checked += 1;
          if (candidate.command) {
            assert.ok(CASE_COMMAND_TYPES.includes(candidate.command));
            assert.notEqual(candidate.command, "set_priority", "the advisor never proposes changing a priority");
            assert.equal(candidate.executableByViewer, capabilities.has(candidate.command), `${candidate.id} executability matches server capabilities`);
          } else {
            assert.equal(candidate.executableByViewer, false);
          }
          assert.ok(candidate.basis.length > 0 && candidate.reason.length > 0);
          texts.add(candidate.title).add(candidate.reason);
        }
        if (viewer.roles.includes("auditor")) assert.ok(advice.candidates.every((candidate) => !candidate.executableByViewer), "read-only roles can execute nothing");
        if (flow.aggregate.status === "CLOSED") assert.equal(advice.candidates.filter((candidate) => candidate.command).length, 0);
        for (const fact of advice.situation) texts.add(fact.label);
      }
    }
  }
  assert.ok(checked > 2000);
  for (const text of texts) {
    assert.deepEqual(clinicalAssertionWarnings(text), [], `no medical-judgement wording: ${text}`);
    assert.doesNotMatch(text, /重症|軽症|緊急度が(高|低)|優先度を(重大|高|中|低)に/, text);
  }
});
