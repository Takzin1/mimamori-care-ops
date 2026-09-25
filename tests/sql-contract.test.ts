import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function sql(): Promise<string> {
  return readFile(
    new URL("../db/case_store.sql", import.meta.url),
    "utf8",
  );
}

test("Postgres Case Store uses tenant-scoped composite identities", async () => {
  const source = await sql();

  assert.ok(source.includes("primary key (tenant_id, case_id)"));
  assert.ok(
    source.includes("primary key (tenant_id, case_id, sequence)"),
  );
  assert.ok(
    source.includes("foreign key (tenant_id, case_id)"),
  );
  assert.ok(source.includes("on delete restrict"));
});

test("append RPC enforces compare-and-set under a row lock", async () => {
  const source = await sql();

  assert.ok(source.includes("append_care_case_event"));
  assert.ok(source.includes("for update;"));
  assert.ok(source.includes("v_current_version <> p_expected_version"));
  assert.ok(source.includes("'conflict', true"));
  assert.ok(source.includes("v_snapshot_version <> v_next_version"));
  assert.ok(source.includes("v_event_sequence <> v_next_version"));
});

test("snapshot advance and event append live in the same RPC", async () => {
  const source = await sql();
  const functionStart = source.indexOf(
    "create or replace function public.append_care_case_event",
  );
  assert.ok(functionStart >= 0);

  const body = source.slice(functionStart);
  const updateAt = body.indexOf("update public.care_cases");
  const eventAt = body.indexOf("insert into public.care_case_events");

  assert.ok(updateAt >= 0);
  assert.ok(eventAt > updateAt);
});

test("Data API access is fail-closed to server-side service role", async () => {
  const source = await sql();

  assert.ok(
    source.includes(
      "alter table public.care_cases enable row level security;",
    ),
  );
  assert.ok(
    source.includes(
      "alter table public.care_case_events enable row level security;",
    ),
  );
  assert.ok(
    source.includes(
      "revoke all on table public.care_cases from anon, authenticated;",
    ),
  );
  assert.ok(
    source.includes(
      "revoke all on table public.care_case_events from anon, authenticated;",
    ),
  );
  assert.ok(
    source.includes(
      "revoke execute on function public.append_care_case_event",
    ),
  );
  assert.ok(source.includes("to service_role;"));
  assert.equal(
    source.toLowerCase().includes("security definer"),
    false,
    "persistence RPCs must remain security-invoker",
  );
});
