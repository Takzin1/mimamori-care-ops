import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const TABLES = ["care_signals", "care_facility_settings", "care_platform_audit_log", "care_ai_drafts", "care_staff_notifications"];

test("CareOps platform tables are RLS-protected and closed to Data API roles", async () => {
  const sql = await read("db/careops_platform.sql");
  for (const table of TABLES) {
    assert.ok(sql.includes(`alter table public.${table} enable row level security;`), `${table} RLS`);
    assert.ok(sql.includes(`revoke all on table public.${table} from public, anon, authenticated;`), `${table} revoke`);
    assert.ok(sql.includes(`revoke insert, update, delete on table public.${table} from service_role;`), `${table} no direct writes`);
  }
  assert.ok(sql.includes("primary key (tenant_id, id)"), "tenant-scoped identities");
  assert.ok(sql.includes("unique (tenant_id, source_adapter, source_signal_id)"), "signal idempotency");
  assert.ok(sql.includes("care_platform_audit_log is append-only"));
});

test("every CareOps RPC is security definer with a pinned search_path and service-role only", async () => {
  const sql = await read("db/careops_platform.sql");
  const functions = [...sql.matchAll(/create or replace function public\.(\w+)\(/g)].map((match) => match[1]!);
  for (const name of functions.filter((item) => item !== "care_platform_audit_append_only")) {
    const body = sql.slice(sql.indexOf(`function public.${name}(`));
    assert.match(body.slice(0, 600), /security definer\s+set search_path = pg_catalog/, name);
    assert.ok(sql.includes(`'public.${name}(`), `${name} has explicit grants`);
  }
  assert.ok(sql.includes("revoke execute on function %s from public, anon, authenticated"));
});

test("Case store accepts CareOps lifecycle and keeps facility immutable", async () => {
  const sql = await read("db/case_store.sql");
  for (const value of ["'TRIAGED'", "'triaged'", "'reassigned'", "'note_added'", "'escalated'", "'handoff_declined'", "'signal_linked'"]) {
    assert.ok(sql.includes(value), value);
  }
  assert.ok(sql.includes("nullif(p_snapshot->>'facilityId', '') is distinct from v_facility_id"));
  const migration = await read("db/migrations/20261110_0001_careops_case_lifecycle.sql");
  assert.ok(migration.includes("drop constraint if exists care_cases_status_check"));
});

test("membership facility scope changes are audited", async () => {
  const sql = await read("db/identity_store.sql");
  assert.ok(sql.includes("'facility_scope_replaced'"));
  assert.ok(sql.includes("if new.facility_ids is distinct from old.facility_ids then"));
});
