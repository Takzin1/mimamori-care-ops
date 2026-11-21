import assert from "node:assert/strict";
import test from "node:test";
import {
  CaseAccessDeniedError,
  CaseNotFoundError,
  CaseQueueService,
  CaseService,
  InMemoryCaseRepository,
  InMemoryTenantMembershipDirectory,
  InMemoryTenantSlaPolicyDirectory,
  assertCanReadCaseAggregate,
  createCase,
  type CaseRepository,
  type CaseSlaPolicy,
  type StoredCase,
  type TenantMembership,
  type TenantMembershipDirectory,
} from "../src/index.ts";

const now = "2026-11-21T06:30:00.000Z";
const duration = {
  acknowledgeWithinMs: 60000,
  assignWithinMs: 60000,
  firstActionWithinMs: 60000,
  handoffAcceptWithinMs: 60000,
  completeWithinMs: 600000,
};
const policy: CaseSlaPolicy = {
  critical: duration, high: duration, normal: duration, low: duration,
};
const principal: TenantMembership = {
  tenantId: "facility-a",
  principalId: "verified-principal",
  actorId: "staff-a",
  roles: ["supervisor"],
  active: true,
};
const subjectCase = (tenantId = "facility-a", id = "case-a") =>
  createCase({
    id, tenantId, subjectId: "synthetic-subject", sourceAdapter: "test",
    sourceSignalId: "synthetic-" + id, sourceType: "manual",
    priority: "normal", createdAt: now,
  });

function directory(forPrincipal: TenantMembership | null,
  forActor: TenantMembership | null = null): TenantMembershipDirectory {
  return {
    findByPrincipal: async () => forPrincipal,
    findByActorId: async () => forActor,
  };
}

function queueService(store: CaseRepository, memberships: TenantMembershipDirectory) {
  return new CaseQueueService(store, memberships,
    new InMemoryTenantSlaPolicyDirectory({ "facility-a": policy }), () => now);
}

test("a misrouted membership cannot grant access to another tenant/principal", async () => {
  const store = new InMemoryCaseRepository();
  await store.create(subjectCase().event);
  const forged: TenantMembership[] = [
    { ...principal, tenantId: "facility-b" },
    { ...principal, principalId: "someone-else" },
    { ...principal, actorId: "invalid actor id" },
    { ...principal, roles: ["injected-admin"] as unknown as TenantMembership["roles"] },
    { ...principal, active: false },
  ];
  for (const member of forged) {
    const members = directory(member);
    const cases = new CaseService(store, members, () => now);
    const queue = queueService(store, members);
    const query = { tenantId: "facility-a", principalId: "verified-principal", caseId: "case-a" };
    await assert.rejects(cases.operatorContext(query), CaseAccessDeniedError);
    await assert.rejects(cases.get(query), CaseAccessDeniedError);
    await assert.rejects(cases.current(query), CaseAccessDeniedError);
    await assert.rejects(cases.metrics(query), CaseAccessDeniedError);
    await assert.rejects(cases.capabilities(query), CaseAccessDeniedError);
    await assert.rejects(cases.execute({
      ...query, expectedVersion: 1, command: { type: "acknowledge" },
    }), CaseAccessDeniedError);
    await assert.rejects(queue.list(query), CaseAccessDeniedError);
  }
  assert.equal((await store.load("facility-a", "case-a"))?.aggregate.version, 1);
});

test("a misrouted Case read cannot leak or mutate another tenant or Case ID", async () => {
  const store = new InMemoryCaseRepository();
  const legitimate = subjectCase();
  const otherTenant = subjectCase("facility-b", "case-b");
  const otherCase = subjectCase("facility-a", "case-other");
  const mismatchedOrigin: StoredCase = {
    aggregate: legitimate.aggregate,
    events: [otherTenant.event],
  };
  const responses: StoredCase[] = [
    { aggregate: otherTenant.aggregate, events: [otherTenant.event] },
    { aggregate: otherCase.aggregate, events: [otherCase.event] },
    mismatchedOrigin,
  ];
  let appendCalls = 0;
  for (const response of responses) {
    const rogue: CaseRepository = {
      create: (event) => store.create(event),
      load: async () => response,
      list: (tenantId) => store.list(tenantId),
      append: async () => { appendCalls += 1; throw new Error("must never append"); },
    };
    const service = new CaseService(rogue,
      new InMemoryTenantMembershipDirectory([principal]), () => now);
    const query = { tenantId: "facility-a", principalId: "verified-principal", caseId: "case-a" };
    await assert.rejects(service.get(query), CaseNotFoundError);
    await assert.rejects(service.current(query), CaseNotFoundError);
    await assert.rejects(service.metrics(query), CaseNotFoundError);
    await assert.rejects(service.capabilities(query), CaseNotFoundError);
    await assert.rejects(service.execute({
      ...query, expectedVersion: 1, command: { type: "acknowledge" },
    }), CaseNotFoundError);
  }
  assert.equal(appendCalls, 0);
});

test("role-bearing assignment target must match requested tenant and actor", async () => {
  for (const target of [
    { ...principal, tenantId: "facility-b", actorId: "staff-b" },
    { ...principal, tenantId: "facility-a", actorId: "staff-c" },
    { ...principal, tenantId: "facility-a", actorId: "staff-b", active: false },
  ]) {
    const store = new InMemoryCaseRepository();
    const members = directory(principal, target);
    const service = new CaseService(store, members, () => now);
    await store.create(subjectCase().event);
    await service.execute({
      tenantId: "facility-a", caseId: "case-a", principalId: "verified-principal",
      expectedVersion: 1, command: { type: "acknowledge" },
    });
    await assert.rejects(service.execute({
      tenantId: "facility-a", caseId: "case-a", principalId: "verified-principal",
      expectedVersion: 2, command: { type: "assign", assigneeId: "staff-b" },
    }), CaseAccessDeniedError);
    assert.equal((await store.load("facility-a", "case-a"))?.aggregate.status, "ACKNOWLEDGED");
  }
});

test("aggregate access guard checks facility even for a tenant-wide supervisor", () => {
  assert.throws(
    () => assertCanReadCaseAggregate(principal, subjectCase("facility-b").aggregate),
    CaseAccessDeniedError,
  );
});
