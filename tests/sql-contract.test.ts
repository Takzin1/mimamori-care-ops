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
      "revoke all on table public.care_cases from public, anon, authenticated;",
    ),
  );
  assert.ok(
    source.includes(
      "revoke all on table public.care_case_events from public, anon, authenticated;",
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
  assert.equal(
    source.match(/security invoker/g)?.length,
    2,
    "both persistence RPCs must explicitly remain security-invoker",
  );
});


test("Signal identity is unique and retry-safe in Postgres", async () => {
  const source = await sql();

  assert.ok(
    source.includes(
      "unique (tenant_id, source_adapter, source_signal_id)",
    ),
  );
  assert.ok(
    source.includes(
      "on conflict (tenant_id, source_adapter, source_signal_id)",
    ),
  );
  assert.ok(source.includes("'created', false"));
  assert.ok(source.includes("'created', true"));
  assert.ok(source.includes("'signal_replay_mismatch'"));
});

test("Case append cannot rewrite immutable Signal lineage", async () => {
  const source = await sql();
  const appendStart = source.indexOf(
    "create or replace function public.append_care_case_event",
  );
  assert.ok(appendStart >= 0);

  const append = source.slice(appendStart);

  assert.ok(
    append.includes(
      "p_snapshot->>'sourceAdapter' is distinct from v_source_adapter",
    ),
  );
  assert.ok(
    append.includes(
      "p_snapshot->>'sourceSignalId' is distinct from v_source_signal_id",
    ),
  );
  assert.ok(
    append.includes(
      "p_snapshot->>'subjectId' is distinct from v_subject_id",
    ),
  );
  assert.ok(
    append.includes("immutable lineage mutation"),
  );

  const updateStart = append.indexOf("update public.care_cases");
  const eventInsert = append.indexOf(
    "insert into public.care_case_events",
  );
  const updateBlock = append.slice(updateStart, eventInsert);

  assert.equal(updateBlock.includes("source_adapter ="), false);
  assert.equal(updateBlock.includes("source_signal_id ="), false);
  assert.equal(updateBlock.includes("subject_id ="), false);
  assert.equal(updateBlock.includes("source_type ="), false);
});


test("Postgres snapshot persists priority changes as operational state", async () => {
  const source = await sql();

  assert.ok(
    source.includes(
      "priority in ('critical', 'high', 'normal', 'low')",
    ),
  );
  assert.ok(source.includes("'priority_changed'"));
  assert.ok(
    source.includes(
      "care_cases_tenant_priority_status_idx",
    ),
  );

  const appendStart = source.indexOf(
    "create or replace function public.append_care_case_event",
  );
  const append = source.slice(appendStart);

  assert.ok(
    append.includes(
      "set priority = p_snapshot->>'priority'",
    ),
  );
});


test("transactional outbox is durable, idempotent, and lease-based", async () => {
  const source = await sql();

  assert.ok(
    source.includes(
      "create table if not exists public.care_outbox",
    ),
  );
  assert.ok(
    source.includes(
      "unique (tenant_id, delivery_key)",
    ),
  );
  assert.ok(
    source.includes(
      "'case.event.committed'",
    ),
  );
  assert.ok(
    source.includes(
      "'case-event:' || v_case_id || ':' || v_event_sequence",
    ),
  );
  assert.ok(
    source.includes(
      "'case-event:' || p_case_id || ':' || v_event_sequence",
    ),
  );
  assert.ok(
    source.includes(
      "for update skip locked",
    ),
  );
  assert.ok(
    source.includes(
      "status = 'dead_letter'",
    ),
  );
  assert.ok(
    source.includes(
      "'delivery_key_reuse'",
    ),
  );
});

test("outbox RPC access is server-only", async () => {
  const source = await sql();

  assert.ok(
    source.includes(
      "revoke all on table public.care_outbox from public, anon, authenticated",
    ),
  );
  assert.ok(
    source.includes(
      "revoke execute on function public.claim_care_outbox",
    ),
  );
  assert.ok(
    source.includes(
      "grant execute on function public.claim_care_outbox",
    ),
  );
  assert.ok(
    source.includes(
      "revoke delete on table public.care_outbox from service_role",
    ),
  );
});
