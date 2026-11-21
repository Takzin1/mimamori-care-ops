/**
 * Framework persistence against real PostgreSQL (skipped without DATABASE_URL).
 *
 * HTTP API → FrameworkService / CaseService → PostgrestFrameworkStore + PostgrestCaseRepository
 *   → (psql-backed PostgREST stand-in, AS service_role) → db/case_store.sql + db/framework_store.sql
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { PostgrestCaseRepository } from "../src/index.ts";
import {
  FrameworkConflictError,
  FrameworkGovernanceError,
  FrameworkHttpApi,
  PostgrestFrameworkStore,
} from "../src/framework/index.ts";
import { psqlPostgrest } from "./support/psql-postgrest.ts";
import { Clock, TokenAuthenticator, provision, world } from "./support/framework-world.ts";

const baseUrl = process.env.DATABASE_URL;

/**
 * The other real-Postgres test files run in parallel on DATABASE_URL and truncate
 * the Case tables; this file works in its own throwaway database instead.
 */
const isolatedName = `framework_it_${process.pid}`;
const databaseUrl = baseUrl
  ? (() => {
      const url = new URL(baseUrl);
      url.pathname = `/${isolatedName}`;
      return url.toString();
    })()
  : undefined;

function adminSql(query: string): void {
  execFileSync("psql", [baseUrl!, "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", query], { stdio: ["ignore", "pipe", "pipe"] });
}

test.before(() => {
  if (!baseUrl) return;
  adminSql(`drop database if exists ${isolatedName}`);
  adminSql(`create database ${isolatedName}`);
});

test.after(() => {
  if (!baseUrl) return;
  adminSql(`drop database if exists ${isolatedName} with (force)`);
});

function psql(args: string[], role?: string): string {
  return execFileSync("psql", [databaseUrl!, "-X", "-qAt", "-v", "ON_ERROR_STOP=1", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...(role ? { PGOPTIONS: `-c role=${role}` } : {}) },
  }).trim();
}

const sql = (query: string, role?: string) => psql(["-c", query], role);

function denied(query: string, role: string): boolean {
  try {
    sql(query, role);
    return false;
  } catch (error) {
    return /permission denied|must be owner|violates|immutable/i.test(String((error as { stderr?: string }).stderr ?? error));
  }
}

test("Framework records persist in PostgreSQL through the real adapters, with governance and isolation enforced by the DB", { skip: !baseUrl }, async () => {
  psql(["-f", "tests/postgres/bootstrap.sql"]);
  psql(["-f", "db/case_store.sql"]);
  psql(["-f", "db/framework_store.sql"]);
  psql(["-f", "db/framework_store.sql"]); // re-runnable
  psql(["-f", "db/framework_records.sql"]);
  psql(["-f", "db/framework_records.sql"]); // re-runnable
  sql("truncate public.framework_case_step_checks, public.framework_training_attempts, public.framework_case_links, public.framework_manual_versions, public.framework_manuals, public.framework_tenant_profiles, public.care_outbox, public.care_case_events, public.care_cases;");

  const rest = psqlPostgrest(databaseUrl!);
  const clock = new Clock();
  const store = new PostgrestFrameworkStore({ baseUrl: "http://postgrest.test", serviceRoleKey: "test-service-role", fetchImpl: rest.fetch });
  const repository = new PostgrestCaseRepository({ baseUrl: "http://postgrest.test", serviceRoleKey: "test-service-role", fetchImpl: rest.fetch });
  const { framework, records, caseService } = world({ store, repository, clock });

  await provision(framework);
  assert.equal(sql("select count(*) from public.framework_manual_versions where status = 'approved'"), "4");
  assert.equal(sql("select count(distinct tenant_id) from public.framework_manuals"), "2");

  // Search runs in SQL and is tenant-scoped.
  const hits = await framework.search("p-resp-a", "facility-a", { text: "転倒 記録" });
  assert.deepEqual(hits.map((h) => h.manualId), ["care-fall-response"]);
  assert.deepEqual(await framework.search("p-resp-a", "facility-a", { text: "防災" }), []);
  assert.equal((await framework.search("p-resp-b", "school-b", { text: "防災 点呼" }))[0]?.manualId, "education-disaster-drill");

  // Manual → Case through the HTTP API, persisted in both stores.
  const api = new FrameworkHttpApi({ authenticator: new TokenAuthenticator(), service: framework });
  const response = await api.handle(new Request("https://framework.test/api/framework/tenants/facility-a/manuals/care-fall-response/cases", {
    method: "POST",
    headers: { authorization: "Bearer tok-resp-a", "content-type": "application/json" },
    body: JSON.stringify({ manualVersion: 1, signalId: "pg-sig-1", subjectRef: "2F-203" }),
  }));
  assert.equal(response.status, 201);
  const { aggregate } = (await response.json()) as { aggregate: { id: string } };
  assert.equal(sql(`select source_adapter || '/' || status from public.care_cases where tenant_id = 'facility-a' and case_id = '${aggregate.id}'`), "framework_manual/NEW");
  assert.equal(sql(`select manual_id || '@' || manual_version from public.framework_case_links where case_id = '${aggregate.id}'`), "care-fall-response@1");
  const replay = await framework.openCaseFromManual("p-resp-a", "facility-a", { manualId: "care-fall-response", manualVersion: 1, signalId: "pg-sig-1", subjectRef: "2F-203" });
  assert.equal(replay.created, false);
  assert.equal(sql("select count(*) from public.care_cases"), "1");

  // Revision: supersede is atomic in SQL; the old link still resolves.
  await framework.reviseManual("p-sup-a2", "facility-a", "care-fall-response", { steps: [{ id: "care-fall-1", text: "改訂", critical: true }] });
  await framework.submitVersion("p-sup-a2", "facility-a", "care-fall-response", 2);
  await assert.rejects(framework.reviewVersion("p-sup-a2", "facility-a", "care-fall-response", 2, { approve: true }), FrameworkGovernanceError);
  clock.advance(60_000);
  await framework.reviewVersion("p-sup-a1", "facility-a", "care-fall-response", 2, { approve: true });
  assert.equal(sql("select string_agg(version || ':' || status, ',' order by version) from public.framework_manual_versions where manual_id = 'care-fall-response'"), "1:superseded,2:approved");
  assert.equal((await framework.caseManual("p-sup-a1", "facility-a", aggregate.id)).link?.manualVersion, 1);
  await assert.rejects(
    framework.openCaseFromManual("p-resp-a", "facility-a", { manualId: "care-fall-response", manualVersion: 1, signalId: "pg-sig-2", subjectRef: "2F-204" }),
    (e: unknown) => e instanceof FrameworkConflictError && e.reason === "manual_version_stale",
  );

  // P2: training records, step checks and evidence persist through the same adapters.
  const quiz = await records.submitQuiz("p-resp-a", "facility-a", "care-fall-response-drill", { attemptId: "pg-quiz-0001", answers: { q1: "a", q2: "b" } });
  assert.equal(quiz.recorded, true);
  assert.equal(quiz.attempt.passed, false);
  assert.equal((await records.submitQuiz("p-resp-a", "facility-a", "care-fall-response-drill", { attemptId: "pg-quiz-0001", answers: { q1: "b", q2: "b" } })).recorded, false);
  const scenarioCourse = (await records.courseDetail("p-resp-a", "facility-a", "care-fall-response-drill"));
  assert.equal(scenarioCourse.manual.version, 2, "training binds to the currently approved version");
  const { INDUSTRY_PACKS } = await import("../src/framework/index.ts");
  const drillSteps = INDUSTRY_PACKS.care.trainings.find((t) => t.key === "fall-response-drill")!.scenario;
  const drill = await records.scenario("p-resp-a", "facility-a", "care-fall-response-drill", {
    attemptId: "pg-drill-0001", answers: drillSteps.map((st) => ({ stepId: st.id, choiceId: st.correctChoiceId })), final: true,
  });
  assert.equal(drill.recorded, true);
  assert.equal(sql("select count(*) || '/' || bool_and(simulated) from public.framework_training_attempts"), "2/true");
  assert.equal(sql("select count(*) from public.care_cases"), "1", "training created no real Case");

  let version = (await caseService.get({ tenantId: "facility-a", caseId: aggregate.id, principalId: "p-disp-a" }))!.aggregate.version;
  for (const [principalId, command] of [["p-disp-a", { type: "acknowledge" }], ["p-disp-a", { type: "assign", assigneeId: "resp-a" }], ["p-resp-a", { type: "start_action" }]] as const) {
    version = (await caseService.execute({ tenantId: "facility-a", caseId: aggregate.id, principalId, expectedVersion: version, command: command as never })).aggregate.version;
  }
  assert.equal((await records.checkStep("p-resp-a", "facility-a", aggregate.id, "care-fall-1")).created, true);
  assert.equal((await records.checkStep("p-resp-a", "facility-a", aggregate.id, "care-fall-1")).created, false);
  await assert.rejects(records.checkStep("p-resp-a", "facility-a", aggregate.id, "care-fall-9"));
  const evidence = await records.evidence("p-sup-a1", "facility-a", aggregate.id);
  assert.equal(evidence.manual?.version, 1);
  assert.deepEqual(evidence.steps?.checked.map((c) => c.stepId), ["care-fall-1"]);
  assert.deepEqual(evidence.timeline.map((t) => t.type), ["case_created", "acknowledged", "assigned", "action_started"]);
  assert.equal(sql(`select count(*) from public.framework_case_step_checks where case_id = '${aggregate.id}'`), "1");

  // Database-level invariants, independent of the application.
  assert.ok(denied("update public.framework_training_attempts set simulated = false", "postgres"), "training records are always simulated");
  assert.ok(denied("insert into public.framework_case_step_checks values ('facility-a','case-without-link','care-fall-1','x',now())", "postgres"), "step checks need a manual-linked Case");
  assert.ok(denied("delete from public.framework_training_attempts", "service_role"), "training records are append-only for the runtime");
  assert.equal(sql("select count(*) from information_schema.columns where table_name = 'framework_training_attempts' and column_name like '%case%'"), "0", "training records cannot reference a Case");
  assert.ok(denied("update public.framework_manual_versions set steps = '[]'::jsonb where version = 1", "postgres"), "reviewed content is immutable even for the owner");
  assert.ok(denied("update public.framework_manual_versions set reviewed_by = created_by where status = 'approved'", "postgres"), "four-eyes check constraint");
  assert.ok(denied("insert into public.framework_case_links values ('facility-a','case-x','care-fall-response',1,'s','r','a',now())", "service_role"), "service_role cannot write tables directly");
  assert.ok(denied("select * from public.framework_manuals", "anon"), "anon has no access");
  assert.ok(denied("select public.framework_search_manuals('{}'::jsonb)", "authenticated"), "authenticated cannot call RPCs");
  assert.ok(denied("insert into public.framework_case_links values ('school-b','" + aggregate.id + "','care-fall-response',1,'s2','r','a',now())", "postgres"), "a link cannot point at another tenant's Case or manual");
  assert.equal(sql("select relrowsecurity from pg_class where relname = 'framework_case_links'"), "t");

  assert.ok(rest.calls.some((c) => c === "rpc:framework_search_manuals"));
  assert.ok(rest.calls.some((c) => c === "rpc:create_care_case"));
});

test("search latency on 5,000 approved manuals per tenant (measured, reported)", { skip: !baseUrl }, () => {
  sql("delete from public.framework_case_step_checks; delete from public.framework_training_attempts; delete from public.framework_case_links; delete from public.framework_manual_versions; delete from public.framework_manuals; delete from public.framework_tenant_profiles;");
  sql("insert into public.framework_tenant_profiles values ('bench-a','care','x','A','b',now()), ('bench-b','care','x','B','b',now());");
  sql(`insert into public.framework_manuals
         select t, 'm' || g, 'care', 'incident', 'てすと手順' || g || case when g % 50 = 0 then ' 転倒' else '' end,
                array['tag' || (g % 10)], null, 'author', now(), 'てすと手順' || g || case when g % 50 = 0 then ' 転倒' else '' end, 'tag' || (g % 10)
           from generate_series(1, 5000) g, unnest(array['bench-a', 'bench-b']) t;`);
  sql(`insert into public.framework_manual_versions
         (tenant_id, manual_id, version, status, summary, steps, default_priority, created_by, created_at, reviewed_by, reviewed_at, effective_from, search_summary, search_steps)
         select tenant_id, manual_id, 1, 'approved', '要約', '[{"id":"s1","text":"手順"}]'::jsonb, 'normal', 'author', now(), 'reviewer', now(), now() - interval '1 minute', 'ようやく', '手順 記録 確認'
           from public.framework_manuals;`);
  sql("analyze public.framework_manuals; analyze public.framework_manual_versions;");
  const payload = JSON.stringify({ tenantId: "bench-a", terms: ["転倒"], category: null, limit: 20, now: new Date().toISOString() }).replaceAll("'", "''");
  const timings: number[] = [];
  let count = 0;
  for (let i = 0; i < 7; i++) {
    const started = process.hrtime.bigint();
    const out = sql(`select public.framework_search_manuals('${payload}'::jsonb)::text`);
    timings.push(Number(process.hrtime.bigint() - started) / 1e6);
    count = (JSON.parse(out) as { hits: unknown[] }).hits.length;
  }
  timings.sort((a, b) => a - b);
  console.log(`framework search (5,000 manuals/tenant, 10,000 rows total): hits=${count}, median=${timings[3]!.toFixed(1)}ms, max=${timings[6]!.toFixed(1)}ms (includes psql process start)`);
  assert.equal(count, 20, "limit applies; 100 matching manuals in tenant A only");
  assert.ok(timings[3]! < 2000, "median well under the 10s field-search target");
});
