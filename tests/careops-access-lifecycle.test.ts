import assert from "node:assert/strict";
import test from "node:test";

import {
  CareOpsPlatformService,
  CaseAccessDeniedError,
  InMemoryAiDraftStore,
  InMemoryAuditLogStore,
  InMemoryCaseRepository,
  InMemoryFacilitySettingsStore,
  InMemoryOutboxStore,
  InMemorySignalStore,
  InMemoryStaffNotificationInbox,
  defaultFacilitySettings,
  type TenantMembership,
  type TenantMembershipDirectory,
} from "../src/index.ts";

/** Directory whose rows change between requests, like the real store. */
class MutableDirectory implements TenantMembershipDirectory {
  rows = new Map<string, TenantMembership>();
  set(row: TenantMembership) { this.rows.set(row.principalId, structuredClone(row)); }
  update(principalId: string, patch: Partial<TenantMembership>) {
    const row = this.rows.get(principalId)!;
    this.rows.set(principalId, { ...row, ...patch });
  }
  async findByPrincipal(tenantId: string, principalId: string) {
    const row = this.rows.get(principalId);
    return row && row.tenantId === tenantId ? structuredClone(row) : null;
  }
  async findByActorId(tenantId: string, actorId: string) {
    const row = [...this.rows.values()].find((item) => item.actorId === actorId && item.tenantId === tenantId);
    return row ? structuredClone(row) : null;
  }
  async listByTenant(tenantId: string) {
    return [...this.rows.values()].filter((row) => row.tenantId === tenantId).map((row) => structuredClone(row));
  }
}

function setup() {
  const directory = new MutableDirectory();
  const member = (principalId: string, actorId: string, roles: TenantMembership["roles"], facilityIds?: string[]) =>
    directory.set({ tenantId: "t", principalId, actorId, roles, active: true, ...(facilityIds ? { facilityIds } : {}) });
  member("p-creator", "creator", ["responder"], ["fac-a"]);
  member("p-disp", "disp", ["dispatcher"], ["fac-a"]);
  member("p-sup", "sup", ["supervisor"], ["fac-a"]);
  const now = () => "2026-11-10T09:00:00.000Z";
  const platform = new CareOpsPlatformService({
    repository: new InMemoryCaseRepository(),
    memberships: directory,
    signals: new InMemorySignalStore(),
    settings: new InMemoryFacilitySettingsStore([
      defaultFacilitySettings({ tenantId: "t", facilityId: "fac-a", displayName: "A", now: now() }),
      defaultFacilitySettings({ tenantId: "t", facilityId: "fac-b", displayName: "B", now: now() }),
    ]),
    audit: new InMemoryAuditLogStore(),
    drafts: new InMemoryAiDraftStore(),
    outbox: new InMemoryOutboxStore(now),
    inbox: new InMemoryStaffNotificationInbox(),
    now,
  });
  const ctx = (principalId: string) => ({ tenantId: "t", principalId });
  return { directory, platform, ctx };
}

test("Case creator reads the Case only while facility membership and read permission hold", async () => {
  const { directory, platform, ctx } = setup();
  const created = await platform.createCase(ctx("p-creator"), { facilityId: "fac-a", subjectId: "resident-ref-1", sourceType: "manual", priority: "low", rawText: "気付き" });
  const caseId = created.aggregate.id;
  assert.equal((await platform.caseDetail(ctx("p-creator"), caseId)).aggregate.createdBy, "creator");
  assert.equal((await platform.listCases(ctx("p-creator"), {})).total, 1);

  // facility transfer: creator no longer in fac-a
  directory.update("p-creator", { facilityIds: ["fac-b"] });
  await assert.rejects(platform.caseDetail(ctx("p-creator"), caseId), CaseAccessDeniedError);
  assert.equal((await platform.listCases(ctx("p-creator"), {})).total, 0);
  assert.equal((await platform.handoffBoard(ctx("p-creator"))).unaccepted.length, 0);

  // back in the facility but read permission removed (no roles cannot be stored; use inactive)
  directory.update("p-creator", { facilityIds: ["fac-a"], active: false });
  await assert.rejects(platform.caseDetail(ctx("p-creator"), caseId), CaseAccessDeniedError);
  await assert.rejects(platform.dashboard(ctx("p-creator")), CaseAccessDeniedError);

  directory.update("p-creator", { active: true });
  assert.equal((await platform.caseDetail(ctx("p-creator"), caseId)).aggregate.id, caseId);
});

test("role changes and departures take effect on the next request", async () => {
  const { directory, platform, ctx } = setup();
  const created = await platform.createCase(ctx("p-disp"), { facilityId: "fac-a", subjectId: "resident-ref-2", sourceType: "manual", priority: "low" });
  let aggregate = (await platform.execute(ctx("p-disp"), created.aggregate.id, 1, { type: "acknowledge" })).aggregate;

  directory.update("p-disp", { roles: ["auditor"] });
  await assert.rejects(platform.execute(ctx("p-disp"), aggregate.id, aggregate.version, { type: "add_note", kind: "other", text: "x" }), CaseAccessDeniedError);
  assert.equal((await platform.caseDetail(ctx("p-disp"), aggregate.id)).aggregate.id, aggregate.id, "auditor keeps read access");

  directory.update("p-disp", { active: false });
  await assert.rejects(platform.caseDetail(ctx("p-disp"), aggregate.id), CaseAccessDeniedError);

  // an assignee who leaves cannot be assigned or receive handoffs
  directory.set({ tenantId: "t", principalId: "p-resp", actorId: "resp", roles: ["responder"], active: true, facilityIds: ["fac-a"] });
  directory.update("p-resp", { active: false });
  await assert.rejects(platform.execute(ctx("p-sup"), aggregate.id, aggregate.version, { type: "assign", assigneeId: "resp" }), CaseAccessDeniedError);
  directory.update("p-resp", { active: true, facilityIds: ["fac-b"] });
  await assert.rejects(platform.execute(ctx("p-sup"), aggregate.id, aggregate.version, { type: "assign", assigneeId: "resp" }), CaseAccessDeniedError, "transferred staff cannot be assigned");
  aggregate = (await platform.execute(ctx("p-sup"), aggregate.id, aggregate.version, { type: "assign", assigneeId: "sup" })).aggregate;
  assert.equal(aggregate.assigneeId, "sup");
});
