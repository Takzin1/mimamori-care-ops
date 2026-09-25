import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  createCase,
  executeCommand,
  replayCase,
} from "../src/index.ts";

const databaseUrl = process.env.DATABASE_URL;

function runPsql(args: string[]): string {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  return execFileSync(
    "psql",
    [
      databaseUrl,
      "-X",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      ...args,
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
}

function sql(query: string): string {
  return runPsql(["-c", query]);
}

function applyFile(path: string): void {
  runPsql(["-f", path]);
}

function jsonLiteral(value: unknown): string {
  const json = JSON.stringify(value).replaceAll("'", "''");
  return "'" + json + "'::jsonb";
}

function textLiteral(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

test(
  "real Postgres RPC preserves idempotency, conflicts, atomicity and replay",
  { skip: !databaseUrl },
  () => {
    applyFile("tests/postgres/bootstrap.sql");
    applyFile("db/case_store.sql");

    sql(
      "truncate table public.care_case_events, public.care_cases " +
      "restart identity cascade;",
    );

    const created = createCase({
      id: "case-db-001",
      tenantId: "provider-db",
      sourceAdapter: "integration-test",
      sourceSignalId: "signal-db-001",
      subjectId: "subject-db-001",
      sourceType: "non_response",
      priority: "normal",
      createdAt: "2026-09-25T06:00:00.000Z",
    });

    const createResult = JSON.parse(
      sql(
        "set role service_role; select public.create_care_case(" +
        jsonLiteral(created.aggregate) + "," +
        jsonLiteral(created.event) +
        ")::text;",
      ),
    );

    assert.equal(createResult.ok, true);
    assert.equal(createResult.created, true);
    assert.equal(createResult.caseId, "case-db-001");

    const retry = createCase({
      id: "case-db-retry-proposal",
      tenantId: "provider-db",
      sourceAdapter: "integration-test",
      sourceSignalId: "signal-db-001",
      subjectId: "subject-db-001",
      sourceType: "non_response",
      priority: "normal",
      createdAt: "2026-09-25T06:01:00.000Z",
    });

    const retryResult = JSON.parse(
      sql(
        "set role service_role; select public.create_care_case(" +
        jsonLiteral(retry.aggregate) + "," +
        jsonLiteral(retry.event) +
        ")::text;",
      ),
    );

    assert.equal(retryResult.ok, true);
    assert.equal(retryResult.created, false);
    assert.equal(retryResult.caseId, "case-db-001");

    const countsAfterRetry = JSON.parse(
      sql(
        "select json_build_object(" +
        "'cases',(select count(*) from public.care_cases " +
        "where tenant_id='provider-db')," +
        "'events',(select count(*) from public.care_case_events " +
        "where tenant_id='provider-db'))::text;",
      ),
    );

    assert.deepEqual(countsAfterRetry, {
      cases: 1,
      events: 1,
    });

    const acknowledged = executeCommand(
      created.aggregate,
      1,
      {
        type: "acknowledge",
        actorId: "dispatcher-db",
      },
      "2026-09-25T06:02:00.000Z",
    );

    const appendResult = JSON.parse(
      sql(
        "set role service_role; select public.append_care_case_event(" +
        textLiteral("provider-db") + "," +
        textLiteral("case-db-001") + ",1," +
        jsonLiteral(acknowledged.aggregate) + "," +
        jsonLiteral(acknowledged.event) +
        ")::text;",
      ),
    );

    assert.deepEqual(appendResult, {
      ok: true,
      version: 2,
    });

    const stale = executeCommand(
      created.aggregate,
      1,
      {
        type: "acknowledge",
        actorId: "dispatcher-stale",
      },
      "2026-09-25T06:03:00.000Z",
    );

    const staleResult = JSON.parse(
      sql(
        "set role service_role; select public.append_care_case_event(" +
        textLiteral("provider-db") + "," +
        textLiteral("case-db-001") + ",1," +
        jsonLiteral(stale.aggregate) + "," +
        jsonLiteral(stale.event) +
        ")::text;",
      ),
    );

    assert.equal(staleResult.ok, false);
    assert.equal(staleResult.conflict, true);
    assert.equal(staleResult.currentVersion, 2);

    const assigned = executeCommand(
      acknowledged.aggregate,
      2,
      {
        type: "assign",
        actorId: "dispatcher-db",
        assigneeId: "responder-db",
      },
      "2026-09-25T06:04:00.000Z",
    );

    const invalidEvent = {
      ...assigned.event,
      type: "not_a_real_event",
    };

    assert.throws(() =>
      sql(
        "set role service_role; select public.append_care_case_event(" +
        textLiteral("provider-db") + "," +
        textLiteral("case-db-001") + ",2," +
        jsonLiteral(assigned.aggregate) + "," +
        jsonLiteral(invalidEvent) +
        ")::text;",
      ),
    );

    const afterFailedTransaction = JSON.parse(
      sql(
        "select json_build_object(" +
        "'version',version,'status',status," +
        "'events',(select count(*) from public.care_case_events e " +
        "where e.tenant_id=c.tenant_id and e.case_id=c.case_id)" +
        ")::text from public.care_cases c " +
        "where tenant_id='provider-db' and case_id='case-db-001';",
      ),
    );

    assert.deepEqual(afterFailedTransaction, {
      version: 2,
      status: "ACKNOWLEDGED",
      events: 2,
    });

    const stored = JSON.parse(
      sql(
        "select json_build_object(" +
        "'snapshot',c.snapshot," +
        "'events',(select coalesce(json_agg(e.event order by e.sequence)," +
        "'[]'::json) from public.care_case_events e " +
        "where e.tenant_id=c.tenant_id and e.case_id=c.case_id)" +
        ")::text from public.care_cases c " +
        "where c.tenant_id='provider-db' and c.case_id='case-db-001';",
      ),
    );

    assert.deepEqual(
      replayCase(stored.events),
      stored.snapshot,
    );

    const eventUpdatePrivilege = sql(
      "select has_table_privilege(" +
      "'service_role','public.care_case_events','UPDATE');",
    );
    assert.equal(eventUpdatePrivilege, "f");
  },
);
