import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  createCase,
  defaultFacilitySettings,
  executeCommand,
  linkSignalToCase,
  replayCase,
  type CaseAggregate,
  type CaseCommand,
  type CaseEvent,
} from "../src/index.ts";

const databaseUrl = process.env.DATABASE_URL;

function psql(args: string[]): string {
  return execFileSync("psql", [databaseUrl!, "-X", "-qAt", "-v", "ON_ERROR_STOP=1", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
// Each run uses its own tenant so it never interferes with other
// integration files running concurrently against the same database.
const RUN_TENANT = `tenant-pg-${Date.now()}`;
const sql = (query: string) => psql(["-c", query.replaceAll("tenant-pg", RUN_TENANT)]);
const json = (value: unknown) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
const asService = (query: string) => JSON.parse(sql(`set role service_role; select (${query})::text;`));

test("real Postgres: CareOps lifecycle events, facility lineage and platform RPCs", { skip: !databaseUrl }, () => {
  for (const file of ["tests/postgres/bootstrap.sql", "db/case_store.sql", "db/identity_store.sql", "db/careops_platform.sql"]) {
    psql(["-f", file]);
  }
  // Case with facility goes through the existing RPCs with all new event types.
  const created = createCase({
    id: "case-pg-careops", tenantId: "tenant-pg", facilityId: "fac-pg", subjectId: "resident-ref-pg",
    sourceType: "unwell", sourceAdapter: "staff-entry", sourceSignalId: "sig-pg-1", priority: "normal",
    category: "体調不良", priorityRationale: "合成データ", createdBy: "dispatcher-pg", createdAt: "2026-11-10T00:00:00.000Z",
  });
  assert.equal(asService(`public.create_care_case(${json(created.aggregate)}, ${json(created.event)})`).created, true);
  assert.equal(sql("select facility_id from public.care_cases where tenant_id = 'tenant-pg' and case_id = 'case-pg-careops'"), "fac-pg");

  let aggregate: CaseAggregate = created.aggregate;
  const events: CaseEvent[] = [created.event];
  let minute = 0;
  const append = (event: CaseEvent, next: CaseAggregate, expected = aggregate.version) => {
    const result = asService(
      `public.append_care_case_event('tenant-pg', 'case-pg-careops', ${expected}, ${json(next)}, ${json(event)})`,
    );
    assert.equal(result.ok, true, `append ${event.type}`);
    aggregate = next;
    events.push(event);
  };
  const run = (command: CaseCommand) => {
    minute += 1;
    const result = executeCommand(aggregate, aggregate.version, command, `2026-11-10T00:${String(minute).padStart(2, "0")}:00.000Z`);
    append(result.event, result.aggregate);
  };

  run({ type: "acknowledge", actorId: "dispatcher-pg" });
  run({ type: "triage", actorId: "dispatcher-pg", category: "転倒", priority: "high", rationale: "合成" });
  run({ type: "assign", actorId: "dispatcher-pg", assigneeId: "responder-pg" });
  run({ type: "reassign", actorId: "supervisor-pg", assigneeId: "responder-pg-2", reason: "担当不在" });
  run({ type: "start_action", actorId: "responder-pg-2" });
  run({ type: "add_note", actorId: "responder-pg-2", kind: "observation", text: "合成メモ" });
  run({ type: "escalate", actorId: "responder-pg-2", reason: "合成" });
  run({ type: "clear_escalation", actorId: "supervisor-pg", reason: "合成" });
  run({ type: "request_handoff", actorId: "responder-pg-2", targetAssigneeId: "responder-pg-3", note: "申し送り" });
  run({ type: "decline_handoff", actorId: "responder-pg-3", reason: "合成" });
  run({ type: "request_handoff", actorId: "responder-pg-2", targetAssigneeId: "responder-pg-3" });
  run({ type: "cancel_handoff", actorId: "responder-pg-2", reason: "合成" });
  const linked = linkSignalToCase(aggregate, aggregate.version, { sourceAdapter: "sensor", sourceSignalId: "sig-pg-2", sourceType: "non_response", linkedBy: null }, "2026-11-10T00:30:00.000Z");
  append(linked.event, linked.aggregate);

  const storedEvents = JSON.parse(sql(
    "select json_agg(event order by sequence)::text from public.care_case_events where tenant_id = 'tenant-pg' and case_id = 'case-pg-careops'",
  )) as CaseEvent[];
  const snapshot = JSON.parse(sql("select snapshot::text from public.care_cases where tenant_id = 'tenant-pg' and case_id = 'case-pg-careops'"));
  assert.deepEqual(replayCase(storedEvents), snapshot, "Postgres snapshot equals replay of stored events");
  assert.equal(snapshot.status, "IN_PROGRESS");
  assert.equal(snapshot.linkedSignalCount, 1);

  // facility is immutable lineage
  const moved = { ...aggregate, facilityId: "fac-other" };
  const note = executeCommand(aggregate, aggregate.version, { type: "add_note", actorId: "responder-pg-2", kind: "other", text: "x" }, "2026-11-10T01:00:00.000Z");
  assert.throws(() => sql(`set role service_role; select public.append_care_case_event('tenant-pg', 'case-pg-careops', ${aggregate.version}, ${json({ ...note.aggregate, facilityId: moved.facilityId })}, ${json(note.event)});`));

  // signals: idempotent record, CAS decision, immutable original text
  const signal = {
    id: "sig-rec-1", tenantId: "tenant-pg", facilityId: "fac-pg", sourceAdapter: "line", sourceSignalId: "m-1",
    sourceType: "free_text", subjectId: "resident-ref-pg", receivedAt: "2026-11-10T00:00:00.000Z", rawText: "原文",
    priorityHint: null, disposition: "pending", caseId: null, decidedBy: null, decidedAt: null, dismissReason: null, replayCount: 0, receivedBy: null,
  };
  assert.equal(asService(`public.record_care_signal(${json(signal)})`).created, true);
  assert.equal(asService(`public.record_care_signal(${json({ ...signal, id: "sig-rec-dup" })})`).created, false);
  assert.equal(asService("public.increment_care_signal_replay('tenant-pg', 'sig-rec-1')").ok, true);
  const decision = { ...signal, disposition: "dismissed", rawText: "改ざん", dismissReason: "合成", decidedBy: "dispatcher-pg", decidedAt: "2026-11-10T00:05:00.000Z" };
  assert.equal(asService(`public.decide_care_signal('tenant-pg', 'sig-rec-1', 'pending', ${json(decision)})`).ok, true);
  assert.equal(asService(`public.decide_care_signal('tenant-pg', 'sig-rec-1', 'pending', ${json(decision)})`).ok, false, "CAS");
  const storedSignal = JSON.parse(sql("select record::text from public.care_signals where tenant_id = 'tenant-pg' and id = 'sig-rec-1'"));
  assert.equal(storedSignal.rawText, "原文", "original text cannot be rewritten by a decision");
  assert.equal(storedSignal.replayCount, 1);

  // settings CAS
  const settings = defaultFacilitySettings({ tenantId: "tenant-pg", facilityId: "fac-pg", displayName: "合成施設", now: "2026-11-10T00:00:00.000Z" });
  assert.equal(asService(`public.save_care_facility_settings(${json(settings)}, 0)`).ok, true);
  assert.equal(asService(`public.save_care_facility_settings(${json({ ...settings, version: 2 })}, 1)`).ok, true);
  assert.equal(asService(`public.save_care_facility_settings(${json({ ...settings, version: 2 })}, 1)`).ok, false);

  // audit log is append-only
  const entry = { id: "audit-1", tenantId: "tenant-pg", facilityId: "fac-pg", at: "2026-11-10T00:00:00.000Z", actorId: "supervisor-pg", action: "settings.updated", targetType: "settings", targetId: "fac-pg", before: null, after: null, reason: null };
  assert.equal(asService(`public.append_care_platform_audit(${json(entry)})`).ok, true);
  assert.throws(() => sql("delete from public.care_platform_audit_log where tenant_id = 'tenant-pg' and id = 'audit-1'"), /append-only/);

  // AI draft content is immutable on review
  const draft = { id: "draft-1", tenantId: "tenant-pg", caseId: "case-pg-careops", status: "pending_review", provider: "local-rules", model: "m", generatedAt: "2026-11-10T00:00:00.000Z", content: { text: "下書き" } };
  assert.equal(asService(`public.insert_care_ai_draft(${json(draft)})`).ok, true);
  const review = { ...draft, status: "approved", content: { text: "書き換え" }, reviewedBy: "dispatcher-pg", reviewedAt: "2026-11-10T00:10:00.000Z" };
  assert.equal(asService(`public.review_care_ai_draft('tenant-pg', 'draft-1', 'pending_review', ${json(review)})`).ok, true);
  const storedDraft = JSON.parse(sql("select draft::text from public.care_ai_drafts where tenant_id = 'tenant-pg' and id = 'draft-1'"));
  assert.equal(storedDraft.content.text, "下書き");
  assert.equal(storedDraft.reviewedBy, "dispatcher-pg");

  // Defense in depth: even a mistaken GRANT to a Data API role exposes no
  // rows, because RLS is enabled and no policies exist (rolled back).
  for (const table of ["care_cases", "care_case_events", "care_signals", "care_platform_audit_log", "care_ai_drafts", "care_tenant_memberships"]) {
    const visible = sql(`begin; grant select on public.${table} to authenticated; set local role authenticated; select count(*) from public.${table}; rollback;`);
    assert.equal(visible.split("\n").filter(Boolean).at(-1), "0", `${table} is RLS-protected`);
  }
  assert.ok(Number(sql("select count(*) from public.care_cases where tenant_id = 'tenant-pg'")) >= 1, "rows exist, so the zero above is RLS");

  // Data API roles have no access; service_role cannot write tables directly
  for (const role of ["anon", "authenticated"]) {
    assert.throws(() => sql(`set role ${role}; select count(*) from public.care_signals;`), /permission denied/);
    assert.throws(() => sql(`set role ${role}; select public.record_care_signal(${json(signal)});`), /permission denied/);
  }
  assert.throws(() => sql(`set role service_role; insert into public.care_signals (tenant_id, id, source_adapter, source_signal_id, source_type, subject_id, disposition, received_at, record) values ('t','x','a','b','manual','s','pending',now(),'{}');`), /permission denied/);

  // membership facility scope: audited like every other membership change
  const principal = `p-pg-${Date.now()}`;
  const admin = "begin; select set_config('care.admin_actor_id', 'admin-pg', true); " +
    "select set_config('care.change_reason', 'integration test', true); select set_config('care.event_at', now()::text, true); ";
  sql(`${admin}insert into public.care_tenant_memberships (tenant_id, principal_id, actor_id, roles, facility_ids) values ('tenant-pg', '${principal}', 'actor-${principal}', array['responder'], array['fac-pg']); commit;`);
  sql(`${admin}update public.care_tenant_memberships set facility_ids = array['fac-pg','fac-pg-2'], version = version + 1 where principal_id = '${principal}'; commit;`);
  assert.equal(sql(`select facility_ids::text from public.care_tenant_memberships where principal_id = '${principal}'`), "{fac-pg,fac-pg-2}");
  const scopeEvent = JSON.parse(sql(`select data::text from public.care_membership_admin_events where principal_id = '${principal}' and event_type = 'facility_scope_replaced'`));
  assert.deepEqual(scopeEvent, { previousFacilityIds: ["fac-pg"], facilityIds: ["fac-pg", "fac-pg-2"] });
  assert.throws(() => sql(`${admin}update public.care_tenant_memberships set facility_ids = array[]::text[], version = version + 1 where principal_id = '${principal}'; commit;`), /facility_ids_check/);
  assert.throws(() => sql(`${admin}update public.care_tenant_memberships set facility_ids = array['x'], roles = array['supervisor'], version = version + 1 where principal_id = '${principal}'; commit;`), /exactly one membership field/);
});
