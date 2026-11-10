import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  CaseStoreCorruptionError,
  applyEvent,
  caseSearchRpcPayload,
  createCase,
  executeCommand,
  validateStoredCase,
  type CaseAggregate,
  type CaseEvent,
} from "../src/index.ts";

/**
 * Upgrade path from the pre-CareOps schema (fixtures copied verbatim from
 * commit cc1f573) to the current schema, with Cases written by the old RPCs.
 */

const databaseUrl = process.env.DATABASE_URL;

const LEGACY_KEYS = [
  "id", "tenantId", "subjectId", "sourceType", "sourceAdapter", "sourceSignalId", "priority", "status", "version",
  "assigneeId", "handoffTargetId", "createdAt", "acknowledgedAt", "assignedAt", "firstActionAt", "completedAt",
  "closedAt", "reopenedCount", "completion",
];
const legacyShape = (aggregate: CaseAggregate) =>
  Object.fromEntries(LEGACY_KEYS.map((key) => [key, (aggregate as unknown as Record<string, unknown>)[key]]));

test("legacy schema and legacy Case snapshots upgrade safely", { skip: !databaseUrl }, () => {
  const admin = (sql: string, url = databaseUrl!) =>
    execFileSync("psql", [url, "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-f", "-"], { encoding: "utf8", input: sql, stdio: ["pipe", "pipe", "pipe"] }).trim();
  const dbName = `careops_legacy_${Date.now()}`;
  admin(`create database ${dbName};`);
  const url = new URL(databaseUrl!);
  url.pathname = `/${dbName}`;
  const run = (sql: string) => admin(sql, url.toString());
  const json = (value: unknown) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
  try {
    run("\\i tests/postgres/bootstrap.sql\n\\i tests/postgres/legacy/case_store.cc1f573.sql\n\\i tests/postgres/legacy/identity_store.cc1f573.sql\n");

    // Write a Case exactly as the legacy runtime did (legacy-shaped snapshots).
    const created = createCase({
      id: "case-legacy-1", tenantId: "tenant-legacy", subjectId: "resident-ref-legacy", sourceType: "non_response",
      sourceAdapter: "legacy-adapter", sourceSignalId: "sig-legacy-1", priority: "normal", createdAt: "2026-09-01T00:00:00.000Z",
    });
    const ack = executeCommand(created.aggregate, 1, { type: "acknowledge", actorId: "legacy-dispatcher" }, "2026-09-01T00:05:00.000Z");
    run(`set role service_role; select public.create_care_case(${json(legacyShape(created.aggregate))}, ${json(created.event)});`);
    run(`set role service_role; select public.append_care_case_event('tenant-legacy', 'case-legacy-1', 1, ${json(legacyShape(ack.aggregate))}, ${json(ack.event)});`);

    // Upgrade: forward migration, then re-apply the current contracts (twice: re-apply safety).
    for (let round = 0; round < 2; round += 1) {
      run("\\i db/migrations/20261110_0001_careops_case_lifecycle.sql\n\\i db/case_store.sql\n\\i db/identity_store.sql\n\\i db/careops_platform.sql\n");
    }

    const snapshot = JSON.parse(run("select snapshot::text from public.care_cases where case_id = 'case-legacy-1'"));
    const events = JSON.parse(run("select json_agg(event order by sequence)::text from public.care_case_events where case_id = 'case-legacy-1'")) as CaseEvent[];
    assert.equal("lastActivityAt" in snapshot, false, "fixture really is legacy-shaped");

    // Legacy snapshot is accepted because every legacy field matches the replay.
    const stored = validateStoredCase("tenant-legacy", "case-legacy-1", snapshot, events);
    assert.equal(stored.aggregate.status, "ACKNOWLEDGED");
    assert.equal(stored.aggregate.facilityId, null);
    // ...but tampering with a legacy field is still detected.
    assert.throws(() => validateStoredCase("tenant-legacy", "case-legacy-1", { ...snapshot, status: "CLOSED" }, events), CaseStoreCorruptionError);

    // New lifecycle events append on top of the legacy Case and write a full snapshot.
    const triage = executeCommand(stored.aggregate, 2, { type: "triage", actorId: "legacy-dispatcher", category: "応答なし", priority: "high", rationale: "移行後の判断" }, "2026-11-10T00:00:00.000Z");
    const appended = JSON.parse(run(`set role service_role; select public.append_care_case_event('tenant-legacy', 'case-legacy-1', 2, ${json(triage.aggregate)}, ${json(triage.event)})::text;`).split("\n").at(-1)!);
    assert.equal(appended.ok, true);
    const after = JSON.parse(run("select snapshot::text from public.care_cases where case_id = 'case-legacy-1'"));
    assert.equal(after.status, "TRIAGED");
    assert.equal("lastActivityAt" in after, true);
    assert.deepEqual(applyEvent(stored.aggregate, triage.event), after);

    // Server-side search finds legacy Cases (null facility, legacy snapshot fields).
    const search = JSON.parse(run(`set role service_role; select public.search_care_cases('tenant-legacy', ${json(caseSearchRpcPayload({ tenantId: "tenant-legacy", facilityScope: null, visibleToActor: null, sort: "createdAt", order: "asc", limit: 10, offset: 0 }))})::text;`).split("\n").at(-1)!);
    assert.equal(search.total, 1);
    // Facility-scoped members never see legacy facility-less Cases.
    const scoped = JSON.parse(run(`set role service_role; select public.search_care_cases('tenant-legacy', ${json(caseSearchRpcPayload({ tenantId: "tenant-legacy", facilityScope: ["fac-a"], visibleToActor: null, sort: "createdAt", order: "asc", limit: 10, offset: 0 }))})::text;`).split("\n").at(-1)!);
    assert.equal(scoped.total, 0);

    // Legacy memberships remain tenant-wide (facility_ids null) after upgrade.
    assert.equal(run("select count(*) from information_schema.columns where table_name = 'care_tenant_memberships' and column_name = 'facility_ids'"), "1");
  } finally {
    admin(`drop database if exists ${dbName};`);
  }
});
