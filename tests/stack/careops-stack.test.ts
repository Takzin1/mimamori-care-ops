import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { STACK_TENANT_ID, staffByKey } from "../../scripts/staging-stack/stack.ts";

/**
 * Staging-equivalent stack test: Supabase-compatible Auth → CareOps staging
 * server (production composition) → PostgREST → PostgreSQL 17.
 * Runs when CAREOPS_STACK_URL is set (CI job `staging-stack`).
 * Synthetic data only.
 */

const env = process.env;
const STACK = env.CAREOPS_STACK_URL;
const skip = !STACK;
const T = STACK_TENANT_ID;

function psql(sql: string): string {
  return execFileSync("psql", [env.DATABASE_URL!, "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
    encoding: "utf8", input: sql, stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function adminUpdate(principalKey: string, setClause: string): void {
  psql([
    "begin;",
    "select set_config('care.admin_actor_id', 'stack-test-admin', true);",
    "select set_config('care.change_reason', 'stack access lifecycle test', true);",
    "select set_config('care.event_at', now()::text, true);",
    `update public.care_tenant_memberships set ${setClause}, version = version + 1 where principal_id = '${staffByKey(principalKey).principalId}';`,
    "commit;",
  ].join("\n"));
}

async function login(key: string): Promise<string> {
  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY!, "content-type": "application/json" },
    body: JSON.stringify({ email: staffByKey(key).email, password: env.STACK_USER_PASSWORD }),
  });
  assert.equal(response.status, 200, `login ${key}`);
  return ((await response.json()) as { access_token: string }).access_token;
}

type Api = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;

function client(token: string, tenant = T): Api {
  return async (method, path, body) => {
    const response = await fetch(`${STACK}/api/care-ops/tenants/${tenant}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
}

test("stack: readiness and Data API lockdown (RLS + grants)", { skip }, async () => {
  assert.equal((await fetch(`${STACK}/healthz`)).status, 200);
  assert.equal((await fetch(`${STACK}/readyz`)).status, 200);
  for (const table of ["care_cases", "care_case_events", "care_signals", "care_platform_audit_log", "care_tenant_memberships", "care_outbox"]) {
    const anon = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?select=*`, {
      headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY!, authorization: `Bearer ${env.SUPABASE_PUBLISHABLE_KEY}` },
    });
    assert.ok(anon.status === 401 || anon.status === 403, `anon cannot read ${table} (got ${anon.status})`);
    const user = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?select=*`, {
      headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY!, authorization: `Bearer ${await login("lead")}` },
    });
    assert.ok(user.status === 401 || user.status === 403, `signed-in users cannot bypass the API to read ${table} (got ${user.status})`);
  }
  const rpc = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/search_care_cases`, {
    method: "POST",
    headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY!, authorization: `Bearer ${await login("lead")}`, "content-type": "application/json" },
    body: JSON.stringify({ p_tenant_id: T, p_query: { limit: 10, sort: "createdAt" } }),
  });
  assert.ok(rpc.status === 401 || rpc.status === 403, `users cannot call service RPCs directly (got ${rpc.status})`);
});

test("stack: Case from notification → judgement → assignment → history → handoff receipt → resolution, persisted in PostgreSQL", { skip }, async () => {
  const desk = client(await login("desk"));
  const lead = client(await login("lead"));
  const r1 = client(await login("r1"));
  const r2 = client(await login("r2"));

  const signal = await desk("POST", "/signals", {
    facilityId: "stack-sakura", sourceAdapter: "phone", sourceSignalId: `stack-${Date.now()}`, sourceType: "unwell",
    subjectId: "resident-ref-stack-01", rawText: "21:05 居室から呼出。腹痛の訴え。",
  });
  assert.equal(signal.status, 201);
  const created = await desk("POST", `/signals/${signal.body.signal.id}/create-case`, { priority: "normal", category: "体調不良", priorityRationale: "腹痛の訴え" });
  assert.equal(created.status, 201);
  const caseId: string = created.body.aggregate.id;
  let version: number = created.body.aggregate.version;
  const command = async (api: Api, payload: unknown, expected = 200) => {
    const result = await api("POST", `/cases/${caseId}/commands`, { expectedVersion: version, command: payload });
    assert.equal(result.status, expected, JSON.stringify(payload));
    if (result.status === 200) version = result.body.aggregate.version;
    return result;
  };

  await command(lead, { type: "acknowledge" });
  await command(lead, { type: "triage", category: "体調不良", priority: "high", rationale: "腹痛継続" });
  await command(lead, { type: "assign", assigneeId: staffByKey("r1").actorId });
  await command(r1, { type: "start_action" });
  await command(r1, { type: "add_note", kind: "observation", text: "21:15 訪問。会話可能。" });
  await command(r1, { type: "request_handoff", targetAssigneeId: staffByKey("r2").actorId, note: "22時に再訪問" });
  const board = await r2("GET", "/handoffs");
  assert.ok(board.body.incoming.some((item: { caseId: string }) => item.caseId === caseId));
  await command(r2, { type: "accept_handoff" });
  await command(r2, { type: "complete", outcome: "confirmed_safe", summary: "症状改善を確認", evidence: [{ kind: "visit", ref: "visit:stack-1" }] });

  const detail = await lead("GET", `/cases/${caseId}/detail`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.aggregate.status, "COMPLETED");
  assert.deepEqual(detail.body.events.map((event: { type: string }) => event.type), [
    "case_created", "acknowledged", "triaged", "assigned", "action_started", "note_added", "handoff_requested", "handoff_accepted", "completed",
  ]);

  // persisted rows in PostgreSQL (not memory)
  assert.equal(psql(`select status from public.care_cases where tenant_id = '${T}' and case_id = '${caseId}'`), "COMPLETED");
  assert.equal(psql(`select count(*) from public.care_case_events where tenant_id = '${T}' and case_id = '${caseId}'`), "9");
  assert.equal(psql(`select disposition from public.care_signals where tenant_id = '${T}' and case_id = '${caseId}'`), "case_created");
  assert.ok(Number(psql(`select count(*) from public.care_platform_audit_log where tenant_id = '${T}'`)) >= 1);
  assert.ok(Number(psql(`select count(*) from public.care_outbox where tenant_id = '${T}' and topic = 'case.event.committed'`)) >= 9, "transactional outbox rows written with each event");

  // server-side search and pagination through the RPC
  const page = await lead("GET", `/cases?status=COMPLETED&sort=createdAt&order=desc&pageSize=1&page=1`);
  assert.equal(page.status, 200);
  assert.ok(page.body.total >= 1);
  assert.equal(page.body.items.length, 1);
});

test("stack: facility isolation, IDOR, privilege escalation and concurrent updates", { skip }, async () => {
  const desk = client(await login("desk"));
  const kaedeLead = client(await login("kaedeLead"));
  const kaedeR = client(await login("kaedeR"));
  const r1 = client(await login("r1"));
  const other = client(await login("other"));
  const otherAsStackTenant = client(await login("other"), T);

  const requestKey = `iso-${Date.now()}`;
  const created = await desk("POST", "/cases", { clientRequestId: requestKey, facilityId: "stack-sakura", subjectId: "resident-ref-stack-02", sourceType: "manual", priority: "normal", rawText: "合成" });
  assert.equal(created.status, 201);
  const caseId: string = created.body.aggregate.id;

  for (const api of [kaedeLead, kaedeR]) {
    assert.equal((await api("GET", `/cases/${caseId}/detail`)).status, 403, "read");
    assert.equal((await api("POST", `/cases/${caseId}/commands`, { expectedVersion: 1, command: { type: "add_note", kind: "other", text: "x" } })).status, 403, "write");
  }
  assert.equal((await kaedeLead("GET", "/cases?facilityId=stack-sakura")).status, 403, "search");
  assert.ok((await kaedeLead("GET", "/cases?q=resident-ref-stack-02")).body.total === 0, "search results scoped");
  assert.equal((await kaedeLead("GET", "/analytics?from=2026-01-01T00:00:00Z&to=2026-12-31T00:00:00Z&facilityId=stack-sakura")).status, 403, "aggregation");
  assert.equal((await kaedeLead("POST", "/cases", { facilityId: "stack-sakura", subjectId: "x", sourceType: "manual", priority: "low" })).status, 403, "client facility_id not trusted");
  assert.equal((await other("GET", "/dashboard")).status, 200, "other tenant user works in own tenant");
  assert.equal((await otherAsStackTenant("GET", `/cases/${caseId}/detail`)).status, 403, "tenant IDOR by path");
  assert.equal((await r1("GET", `/cases/${caseId}/detail`)).status, 403, "responder lateral access");
  assert.equal((await r1("POST", `/cases/${caseId}/commands`, { expectedVersion: 1, command: { type: "acknowledge" } })).status, 403, "role escalation");
  assert.equal((await r1("POST", "/settings/facilities/stack-sakura", { expectedVersion: 1, approveSla: {} })).status, 403, "settings escalation");

  // duplicate submit of the same request returns the same Case
  const again = await desk("POST", "/cases", { clientRequestId: requestKey, facilityId: "stack-sakura", subjectId: "resident-ref-stack-02", sourceType: "manual", priority: "normal", rawText: "合成" });
  assert.equal(again.body.aggregate.id, caseId);

  // concurrent acknowledge: exactly one wins, the other gets 409
  const lead = client(await login("lead"));
  const results = await Promise.all([
    desk("POST", `/cases/${caseId}/commands`, { expectedVersion: 1, command: { type: "acknowledge" } }),
    lead("POST", `/cases/${caseId}/commands`, { expectedVersion: 1, command: { type: "acknowledge" } }),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
});

test("stack: creator visibility, role change, facility transfer and leaving take effect immediately", { skip }, async () => {
  const moverToken = await login("mover");
  const mover = client(moverToken);
  const created = await mover("POST", "/cases", { facilityId: "stack-sakura", subjectId: "resident-ref-stack-03", sourceType: "manual", priority: "low", rawText: "職員の気付き" });
  assert.equal(created.status, 201);
  const caseId: string = created.body.aggregate.id;
  assert.equal((await mover("GET", `/cases/${caseId}/detail`)).status, 200, "creator can read while in the facility");

  // 施設異動: creator moves to another facility → loses access at once
  adminUpdate("mover", "facility_ids = array['stack-kaede']");
  assert.equal((await mover("GET", `/cases/${caseId}/detail`)).status, 403);
  assert.equal((await mover("GET", "/cases?q=resident-ref-stack-03")).body.total, 0);
  assert.equal(psql(`select event_type from public.care_membership_admin_events where principal_id = '${staffByKey("mover").principalId}' order by version desc limit 1`), "facility_scope_replaced");

  // 権限変更: dispatcher reduced to auditor → read-only immediately
  const leaver = client(await login("leaver"));
  assert.equal((await leaver("POST", `/cases/${caseId}/commands`, { expectedVersion: 1, command: { type: "add_note", kind: "other", text: "x" } })).status, 200);
  adminUpdate("leaver", "roles = array['auditor']");
  assert.equal((await leaver("POST", `/cases/${caseId}/commands`, { expectedVersion: 2, command: { type: "add_note", kind: "other", text: "y" } })).status, 403);
  assert.equal((await leaver("GET", `/cases/${caseId}/detail`)).status, 200, "auditor may still read");

  // 退職: membership deactivated → every request denied with the same token
  adminUpdate("leaver", "active = false");
  assert.equal((await leaver("GET", "/dashboard")).status, 403);
  assert.equal((await leaver("GET", `/cases/${caseId}/detail`)).status, 403);
});

test("stack: escalation notifications and AI drafts persist through PostgreSQL", { skip }, async () => {
  const desk = client(await login("desk"));
  const lead = client(await login("lead"));
  const critical = await desk("POST", "/cases", { facilityId: "stack-sakura", subjectId: "resident-ref-stack-04", sourceType: "sos", priority: "critical", rawText: "SOSボタン押下。20時 転倒の音。" });
  assert.equal(critical.status, 201);
  const notifications = await lead("GET", "/notifications");
  assert.ok(notifications.body.some((item: { caseId: string; kind: string }) => item.caseId === critical.body.aggregate.id && item.kind === "critical_unacknowledged"));
  const deliveries = await lead("GET", "/notifications/deliveries");
  assert.ok(deliveries.body.some((item: { status: string }) => item.status === "delivered"));

  const draft = await desk("POST", `/cases/${critical.body.aggregate.id}/ai-drafts`, { kind: "case_summary" });
  assert.equal(draft.status, 201);
  assert.equal(draft.body.status, "pending_review");
  const review = await desk("POST", `/cases/${critical.body.aggregate.id}/ai-drafts/${draft.body.id}/review`, { decision: "approve", expectedVersion: critical.body.aggregate.version });
  assert.equal(review.status, 200);
  assert.equal(psql(`select status from public.care_ai_drafts where tenant_id = '${T}' and id = '${draft.body.id}'`), "approved");
  const stored = JSON.parse(psql(`select draft::text from public.care_ai_drafts where tenant_id = '${T}' and id = '${draft.body.id}'`));
  assert.equal(stored.content.text, draft.body.content.text, "generated content is immutable");
});
