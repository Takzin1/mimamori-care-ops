import assert from "node:assert/strict";
import test from "node:test";
import { createCase, executeCommand, DockContractError, DockRegistry, explainCaseStage, explainNextStep } from "../src/index.ts";
import type { CareOpsClient } from "../src/client/types.ts";

const tenant = "tenant-a";
const initial = createCase({
  id: "case-01", tenantId: tenant, subjectId: "synthetic-01",
  sourceType: "manual", sourceAdapter: "test",
  sourceSignalId: "test-01", priority: "normal",
  createdAt: "2026-11-21T01:00:00Z",
});
const acknowledged = executeCommand(initial.aggregate, 1,
  { type: "acknowledge", actorId: "staff-01" }, "2026-11-21T01:01:00Z");

function mockClient(calls: string[], responseTenant = tenant): CareOpsClient {
  return {
    async queue(t) {
      calls.push("queue:" + t);
      return {
        tenantId: responseTenant, evaluatedAt: "2026-11-21T01:00:00Z",
        items: [], summary: { total: 0, breached: 0, unacknowledged: 0,
          unassigned: 0, handoffPending: 0,
          byPriority: { critical: 0, high: 0, normal: 0, low: 0 } },
      };
    },
    async getCase(t, id) {
      calls.push("get:" + t + ":" + id);
      return { aggregate: { ...initial.aggregate, tenantId: responseTenant }, events: [initial.event] };
    },
    async caseCapabilities(t, id) {
      calls.push("caps:" + t + ":" + id);
      return { tenantId: responseTenant, caseId: id, version: 1,
        status: "NEW", operator: { tenantId: responseTenant,
          actorId: "staff-01", roles: ["responder"], queueVisibility: "responder" },
        commands: [] };
    },
    async execute(t, id, version, command) {
      calls.push("execute:" + t + ":" + id + ":" + version + ":" + command.type);
      return { aggregate: { ...acknowledged.aggregate, tenantId: responseTenant }, event: acknowledged.event };
    },
    async operatorContext() { throw new Error("out of scope"); },
    async metrics() { throw new Error("out of scope"); },
  };
}

test("dock registry only exposes explicitly registered, validated first-party manifests", () => {
  const calls: string[] = [];
  const registry = new DockRegistry(mockClient(calls), tenant);
  const submitted = { id: "manual-dock", version: "1.0.0", title: "Manual", operations: ["case.queue", "case.read"] as const };
  registry.register(submitted);
  assert.equal(registry.list().length, 1);
  assert.equal(Object.isFrozen(registry.list()[0]), true);
  assert.equal(Object.isFrozen(registry.list()[0]?.operations), true);
  assert.throws(() => registry.register(submitted), DockContractError);
  assert.throws(() => registry.connect("other-dock"), DockContractError);
  assert.throws(() => registry.register({ ...submitted, id: "../escape" }), DockContractError);
  assert.throws(() => registry.register({ ...submitted, version: "latest" }), DockContractError);
  assert.throws(() => registry.register({ ...submitted, id: "bad", operations: ["case.execute"] }), DockContractError);
  assert.deepEqual(calls, []);
});

test("dock passes only fixed tenant scope through existing authenticated Core client", async () => {
  const calls: string[] = [];
  const registry = new DockRegistry(mockClient(calls), tenant);
  registry.register({ id: "manual-dock", version: "1.0.0", title: "Manual",
    operations: ["case.queue", "case.read"] });
  const dock = registry.connect("manual-dock");
  await dock.queue();
  await dock.getCase("case-01");
  await dock.capabilities("case-01");
  await assert.rejects(dock.execute("case-01", 1, { type: "acknowledge" }), DockContractError);
  assert.deepEqual(calls, ["queue:tenant-a", "get:tenant-a:case-01", "caps:tenant-a:case-01"]);
});

test("dock fails closed on wrong tenant result and invalid identifier before command", async () => {
  const calls: string[] = [];
  const registry = new DockRegistry(mockClient(calls, "tenant-b"), tenant);
  registry.register({ id: "line-dock", version: "1.0.0", title: "LINE",
    operations: ["case.queue", "case.read", "case.execute"] });
  const dock = registry.connect("line-dock");
  await assert.rejects(dock.queue(), DockContractError);
  await assert.rejects(dock.getCase("case-01"), DockContractError);
  await assert.rejects(dock.execute("case-01", 1, { type: "acknowledge" }), DockContractError);
  await assert.rejects(dock.execute("case/../../other", 1, { type: "acknowledge" }), DockContractError);
  await assert.rejects(dock.execute("case-01", 0, { type: "acknowledge" }), DockContractError);
  assert.deepEqual(calls, [
    "queue:tenant-a", "get:tenant-a:case-01", "execute:tenant-a:case-01:1:acknowledge"
  ]);
});

test("dock rejects a cross-tenant queue item even when the envelope matches", async () => {
  const calls: string[] = [];
  const client = mockClient(calls);
  const originalQueue = client.queue.bind(client);
  client.queue = async (requestedTenant) => {
    const result = await originalQueue(requestedTenant);
    return { ...result, items: [{ tenantId: "tenant-b" } as any] };
  };
  const registry = new DockRegistry(client, tenant);
  registry.register({ id: "report-dock", version: "1.0.0", title: "Report",
    operations: ["case.queue"] });
  await assert.rejects(registry.connect("report-dock").queue(), DockContractError);
  assert.deepEqual(calls, ["queue:tenant-a"]);
});

test("next step is descriptive and never invents a command when not permitted", () => {
  assert.equal(explainCaseStage("HANDOFF_PENDING"), "引き継ぎ先の受諾待ち");
  const accepted = explainNextStep("HANDOFF_PENDING", "receiver", "sender", "receiver",
    [{ type: "accept_handoff", label: "受諾", requires: [] }]);
  assert.match(accepted, /受諾してください/);
  assert.match(accepted, /前担当者が責任/);
  const waiting = explainNextStep("HANDOFF_PENDING", "sender", "sender", "receiver", []);
  assert.match(waiting, /受諾を待っています/);
  assert.doesNotMatch(waiting, /受諾してください/);
  assert.match(explainNextStep("IN_PROGRESS", "current", "current", null,
    [{ type: "complete", label: "完了", requires: ["outcome", "evidence"] }]), /証跡/);
  assert.match(explainNextStep("IN_PROGRESS", "other", "current", null, []), /担当者が対応中/);
});
