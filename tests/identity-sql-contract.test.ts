import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function sql(): Promise<string> {
  return readFile(
    new URL("../db/identity_store.sql", import.meta.url),
    "utf8",
  );
}

test("membership store uses tenant-scoped principal and actor identities", async () => {
  const source = await sql();

  assert.ok(
    source.includes(
      "primary key (tenant_id, principal_id)",
    ),
  );
  assert.ok(
    source.includes(
      "unique (tenant_id, actor_id)",
    ),
  );
  assert.ok(
    source.includes(
      "'dispatcher'",
    ),
  );
  assert.ok(source.includes("'responder'"));
  assert.ok(source.includes("'supervisor'"));
  assert.ok(source.includes("'auditor'"));
});

test("membership store is fail-closed to server-side lookup only", async () => {
  const source = await sql();

  assert.ok(
    source.includes(
      "alter table public.care_tenant_memberships enable row level security",
    ),
  );
  assert.ok(
    source.includes(
      "revoke all on table public.care_tenant_memberships",
    ),
  );
  assert.ok(
    source.includes(
      "from public, anon, authenticated",
    ),
  );
  assert.ok(
    source.includes(
      "revoke insert, update, delete on table public.care_tenant_memberships",
    ),
  );
  assert.ok(
    source.includes(
      "grant select on table public.care_tenant_memberships",
    ),
  );
  assert.ok(source.includes("to service_role"));
});
