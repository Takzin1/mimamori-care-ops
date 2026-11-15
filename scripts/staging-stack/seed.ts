import { execFileSync } from "node:child_process";

import { CareOpsPlatformService } from "../../src/careops/platform-service.ts";
import { createPostgrestPlatformStores } from "../../src/careops/postgrest-stores.ts";
import { InMemoryTenantMembershipDirectory } from "../../src/access/in-memory-membership-directory.ts";
import { PostgrestCaseRepository } from "../../src/persistence/postgrest-case-repository.ts";
import { STACK_FACILITIES, STACK_STAFF, STACK_TENANT_ID } from "./stack.ts";

/**
 * Seeds the staging-equivalent stack with SYNTHETIC data:
 * - memberships through the audited admin context (care.admin_actor_id …)
 * - facilities through PostgREST with the production adapters
 * Idempotent: safe to run more than once.
 */

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

export function membershipSeedSql(): string {
  const rows = STACK_STAFF.map((staff) =>
    `(${literal(staff.tenantId)}, ${literal(staff.principalId)}, ${literal(staff.actorId)}, ` +
    `array[${staff.roles.map(literal).join(",")}]::text[], ` +
    `${staff.facilityIds ? `array[${staff.facilityIds.map(literal).join(",")}]::text[]` : "null"})`,
  );
  return [
    "begin;",
    "select set_config('care.admin_actor_id', 'stack-seed', true);",
    "select set_config('care.change_reason', 'staging-equivalent synthetic seed', true);",
    "select set_config('care.event_at', now()::text, true);",
    "insert into public.care_tenant_memberships (tenant_id, principal_id, actor_id, roles, facility_ids) values",
    rows.join(",\n") ,
    "on conflict (tenant_id, principal_id) do nothing;",
    "commit;",
  ].join("\n");
}

export async function seedStack(env: Record<string, string | undefined>): Promise<void> {
  const databaseUrl = env.DATABASE_URL;
  const supabaseUrl = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!databaseUrl || !supabaseUrl || !serviceRoleKey) {
    throw new Error("DATABASE_URL, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }
  execFileSync("psql", [databaseUrl, "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
    encoding: "utf8",
    input: membershipSeedSql(),
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stores = createPostgrestPlatformStores({ baseUrl: supabaseUrl, serviceRoleKey });
  const platform = new CareOpsPlatformService({
    repository: new PostgrestCaseRepository({ baseUrl: supabaseUrl, serviceRoleKey }),
    memberships: new InMemoryTenantMembershipDirectory([]),
    signals: stores.signals,
    settings: stores.settings,
    audit: stores.audit,
    drafts: stores.drafts,
    outbox: stores.outbox,
    inbox: stores.inbox,
  });
  for (const facility of STACK_FACILITIES) {
    const result = await platform.provisionFacility({ tenantId: STACK_TENANT_ID, ...facility, operator: "stack-seed" });
    process.stdout.write(`${JSON.stringify({ event: "facility_provisioned", facilityId: facility.facilityId, created: result.created })}\n`);
  }
}

if (process.argv[1]?.endsWith("seed.ts")) {
  await seedStack(process.env);
}
