import assert from "node:assert/strict";
import test from "node:test";

import {
  CaseStoreCorruptionError,
  PostgrestTenantMembershipDirectory,
} from "../src/index.ts";

function directory(row: Record<string, unknown>, seen: URL[] = []) {
  return new PostgrestTenantMembershipDirectory({
    baseUrl: "https://db.example.test",
    serviceRoleKey: "service-role-test-key",
    fetchImpl: async (input) => {
      seen.push(new URL(String(input)));
      return new Response(JSON.stringify([row]), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
}

const base = { tenant_id: "t", principal_id: "p", actor_id: "a", roles: ["responder"], active: true };

test("PostgREST memberships carry facility scope; null means tenant-wide", async () => {
  const seen: URL[] = [];
  const scoped = await directory({ ...base, facility_ids: ["fac-a", "fac-a", "fac-b"] }, seen).findByPrincipal("t", "p");
  assert.deepEqual(scoped?.facilityIds, ["fac-a", "fac-b"]);
  assert.match(seen[0]!.searchParams.get("select") ?? "", /facility_ids/);

  const wide = await directory({ ...base, facility_ids: null }).findByPrincipal("t", "p");
  assert.equal(wide?.facilityIds, undefined);
  const legacy = await directory({ ...base }).findByPrincipal("t", "p");
  assert.equal(legacy?.facilityIds, undefined);
});

test("malformed facility scope fails closed", async () => {
  await assert.rejects(directory({ ...base, facility_ids: "fac-a" }).findByPrincipal("t", "p"), CaseStoreCorruptionError);
  await assert.rejects(directory({ ...base, facility_ids: ["bad id"] }).findByPrincipal("t", "p"), CaseStoreCorruptionError);
});
