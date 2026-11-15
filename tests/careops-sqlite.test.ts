import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSqliteStores } from "../server/sqlite-stores.ts";
import {
  CaseConflictError,
  CaseStoreCorruptionError,
  createCase,
  createLocalCareOpsApp,
  executeCommand,
  RuleBasedDraftProvider,
} from "../src/index.ts";

const BASE = "http://localhost/api/care-ops/tenants/demo-tenant";

async function tempDb() {
  const dir = await mkdtemp(join(tmpdir(), "careops-sqlite-"));
  return { path: join(dir, "test.sqlite"), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("SQLite repository: idempotent create, CAS append, append-only events, durable across reopen", async () => {
  const db = await tempDb();
  try {
    let { database, stores } = createSqliteStores(db.path);
    const created = createCase({
      id: "case-sql-1", tenantId: "t", facilityId: "f", subjectId: "s-1", sourceType: "unwell",
      sourceAdapter: "a", sourceSignalId: "sig-1", priority: "normal", createdAt: "2026-11-10T00:00:00.000Z",
    });
    assert.equal((await stores.repository.create(created.event)).created, true);
    assert.equal((await stores.repository.create(created.event)).created, false, "signal replay is idempotent");

    const ack = executeCommand(created.aggregate, 1, { type: "acknowledge", actorId: "d" }, "2026-11-10T00:01:00.000Z");
    await stores.repository.append({ tenantId: "t", caseId: "case-sql-1", expectedVersion: 1, event: ack.event });
    await assert.rejects(
      stores.repository.append({ tenantId: "t", caseId: "case-sql-1", expectedVersion: 1, event: ack.event }),
      CaseConflictError,
    );
    assert.throws(() => database.db.exec("delete from care_case_events"), /append-only/);
    assert.throws(() => database.db.exec("update care_case_events set event = '{}'"), /append-only/);
    assert.equal(await stores.repository.load("other-tenant", "case-sql-1"), null, "tenant-scoped addressing");
    database.close();

    ({ database, stores } = createSqliteStores(db.path));
    const reloaded = await stores.repository.load("t", "case-sql-1");
    assert.equal(reloaded?.aggregate.status, "ACKNOWLEDGED");
    assert.equal(reloaded?.aggregate.facilityId, "f");
    assert.equal(reloaded?.events.length, 2);

    // snapshot tampering is detected on read
    database.db.exec(`update care_cases set snapshot = replace(snapshot, '"ACKNOWLEDGED"', '"CLOSED"')`);
    await assert.rejects(stores.repository.load("t", "case-sql-1"), CaseStoreCorruptionError);
    database.close();
  } finally {
    await db.cleanup();
  }
});

test("SQLite outbox: retry then dead-letter with recorded error", async () => {
  const db = await tempDb();
  try {
    let now = Date.parse("2026-11-10T00:00:00.000Z");
    const clock = () => new Date(now).toISOString();
    const { database, stores } = createSqliteStores(db.path, clock);
    const first = await stores.outbox.enqueue({ tenantId: "t", topic: "x", deliveryKey: "k1", payload: { a: 1 }, maxAttempts: 2 });
    assert.equal((await stores.outbox.enqueue({ tenantId: "t", topic: "x", deliveryKey: "k1", payload: { a: 1 } })).created, false);
    let claimed = await stores.outbox.claim({ tenantId: "t", workerId: "w" });
    assert.equal(claimed.length, 1);
    assert.equal((await stores.outbox.fail({ tenantId: "t", id: first.id, workerId: "w", error: "timeout", retryAt: clock() })).status, "failed");
    now += 1000;
    claimed = await stores.outbox.claim({ tenantId: "t", workerId: "w" });
    assert.equal((await stores.outbox.fail({ tenantId: "t", id: first.id, workerId: "w", error: "timeout again" })).status, "dead_letter");
    const [entry] = await stores.outbox.list("t");
    assert.equal(entry!.status, "dead_letter");
    assert.equal(entry!.lastError, "timeout again");
    assert.equal((await stores.outbox.claim({ tenantId: "t", workerId: "w" })).length, 0);
    database.close();
  } finally {
    await db.cleanup();
  }
});

test("SQLite-backed local app: full workflow persists across a restart", async () => {
  const db = await tempDb();
  try {
    const call = async (app: Awaited<ReturnType<typeof createLocalCareOpsApp>>, principal: string, method: string, path: string, body?: unknown) => {
      const response = await app.api.handle(new Request(`${BASE}${path}`, {
        method,
        headers: { authorization: `Bearer local.${principal}`, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }));
      return { status: response.status, body: await response.json() };
    };

    let opened = createSqliteStores(db.path);
    let app = await createLocalCareOpsApp({ stores: opened.stores, ai: new RuleBasedDraftProvider() });
    const created = await call(app, "dev-dispatcher-sakura", "POST", "/cases", {
      facilityId: "facility-sakura", subjectId: "resident-ref-0500", sourceType: "non_response", priority: "high", rawText: "朝の安否確認に応答なし",
    });
    assert.equal(created.status, 201);
    const caseId = created.body.aggregate.id;
    assert.equal((await call(app, "dev-dispatcher-sakura", "POST", `/cases/${caseId}/commands`, { expectedVersion: 1, command: { type: "acknowledge" } })).status, 200);
    const settings = await call(app, "dev-supervisor-sakura", "GET", "/settings/facilities/facility-sakura");
    await call(app, "dev-supervisor-sakura", "POST", "/settings/facilities/facility-sakura", { expectedVersion: settings.body.version, approveSla: { note: "承認" } });
    opened.database.close();

    opened = createSqliteStores(db.path);
    app = await createLocalCareOpsApp({ stores: opened.stores, ai: new RuleBasedDraftProvider() });
    const detail = await call(app, "dev-supervisor-sakura", "GET", `/cases/${caseId}/detail`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.aggregate.status, "ACKNOWLEDGED");
    assert.equal(detail.body.signals[0].rawText, "朝の安否確認に応答なし");
    assert.equal(detail.body.slaApproved, true, "settings survive restart and seeding does not overwrite them");
    const audit = await call(app, "dev-auditor", "GET", "/audit");
    assert.ok(audit.body.length >= 3);
    opened.database.close();
  } finally {
    await db.cleanup();
  }
});
