import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { createSqliteStores } from "../server/sqlite-stores.ts";
import {
  CASE_PRIORITIES,
  CASE_STATUSES,
  InMemoryCaseRepository,
  UNASSIGNED,
  caseSearchRpcPayload,
  canCaseCommand,
  createCase,
  executeCommand,
  type CaseAggregate,
  type CaseCommand,
  type CaseEvent,
  type CaseSearchQuery,
  type CaseSearchSort,
} from "../src/index.ts";

// Deterministic PRNG so failures are reproducible.
function prng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const ACTORS = ["disp-a", "resp-a", "resp-b", "resp-c", "sup-a"];
const FACILITIES = ["fac-a", "fac-b", undefined];
const CATEGORIES = ["転倒", "Fall", "体調不良", undefined];

function commandFor(type: CaseCommand["type"], aggregate: CaseAggregate, pick: <T>(items: readonly T[]) => T): CaseCommand | null {
  const actor = type === "start_action" || type === "request_handoff" || type === "complete" || type === "cancel_handoff"
    ? aggregate.assigneeId
    : type === "accept_handoff" || type === "decline_handoff"
      ? aggregate.handoffTargetId
      : pick(ACTORS);
  if (!actor) return null;
  switch (type) {
    case "acknowledge": case "start_action": case "accept_handoff": case "close": return { type, actorId: actor };
    case "triage": return { type, actorId: actor, category: pick(["転倒", "Fall"]), priority: pick(CASE_PRIORITIES), rationale: "synthetic" };
    case "assign": return { type, actorId: actor, assigneeId: pick(["resp-a", "resp-b", "resp-c"]) };
    case "reassign": {
      const next = pick(["resp-a", "resp-b", "resp-c"]);
      return next === aggregate.assigneeId ? null : { type, actorId: actor, assigneeId: next, reason: "synthetic" };
    }
    case "add_note": return { type, actorId: actor, kind: "observation", text: "synthetic" };
    case "escalate": case "clear_escalation": case "decline_handoff": case "cancel_handoff": case "reopen":
      return { type, actorId: actor, reason: "synthetic" };
    case "request_handoff": {
      const target = pick(["resp-a", "resp-b", "resp-c"]);
      return target === actor ? null : { type, actorId: actor, targetAssigneeId: target, note: "synthetic" };
    }
    case "complete": return { type, actorId: actor, outcome: "confirmed_safe", summary: "synthetic", evidence: [{ kind: "note", ref: "n" }] };
    case "set_priority": {
      const priority = pick(CASE_PRIORITIES);
      return priority === aggregate.priority ? null : { type, actorId: actor, priority };
    }
  }
}

export function syntheticDataset(tenantId: string, count = 70): Array<{ events: CaseEvent[] }> {
  const random = prng(20261110);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const base = Date.parse("2026-11-01T00:00:00.000Z");
  const result: Array<{ events: CaseEvent[] }> = [];
  for (let index = 0; index < count; index += 1) {
    let minute = index * 37;
    const facility = pick(FACILITIES);
    const category = pick(CATEGORIES);
    const created = createCase({
      id: `case-${String(index).padStart(3, "0")}`,
      tenantId,
      ...(facility ? { facilityId: facility } : {}),
      subjectId: `RES-${index % 9}`,
      sourceType: pick(["unwell", "non_response", "sos", "manual"] as const),
      sourceAdapter: "synthetic",
      sourceSignalId: `sig-${index}`,
      priority: pick(CASE_PRIORITIES),
      ...(category ? { category } : {}),
      ...(random() < 0.4 ? { createdBy: pick(ACTORS) } : {}),
      createdAt: new Date(base + minute * 60_000).toISOString(),
    });
    let aggregate = created.aggregate;
    const events: CaseEvent[] = [created.event];
    const steps = Math.floor(random() * 9);
    for (let step = 0; step < steps; step += 1) {
      const candidates = (["acknowledge", "triage", "assign", "reassign", "start_action", "add_note", "escalate", "clear_escalation", "request_handoff", "accept_handoff", "decline_handoff", "cancel_handoff", "complete", "close", "reopen", "set_priority"] as const)
        .filter((type) => canCaseCommand(aggregate, aggregate.assigneeId ?? aggregate.handoffTargetId ?? "sup-a", type) || ["acknowledge", "triage", "assign", "reassign", "add_note", "escalate", "clear_escalation", "close", "reopen", "set_priority"].includes(type));
      const command = commandFor(pick(candidates), aggregate, pick);
      if (!command || !canCaseCommand(aggregate, command.actorId, command.type)) continue;
      minute += 1 + Math.floor(random() * 50);
      const next = executeCommand(aggregate, aggregate.version, command, new Date(base + minute * 60_000).toISOString());
      aggregate = next.aggregate;
      events.push(next.event);
    }
    result.push({ events });
  }
  return result;
}

export function parityQueries(tenantId: string): CaseSearchQuery[] {
  const sorts: CaseSearchSort[] = ["createdAt", "lastActivityAt", "priority", "status"];
  const base = { tenantId, facilityScope: null, visibleToActor: null, sort: "createdAt" as CaseSearchSort, order: "asc" as const, limit: 25, offset: 0 };
  const queries: CaseSearchQuery[] = [];
  for (const sort of sorts) for (const order of ["asc", "desc"] as const) queries.push({ ...base, sort, order, limit: 7, offset: 3 });
  queries.push(
    { ...base, limit: 2000 },
    { ...base, facilityScope: ["fac-a"] },
    { ...base, facilityScope: ["fac-a", "fac-b"], sort: "priority", order: "desc" },
    { ...base, facilityScope: ["fac-b"], visibleToActor: "resp-a" },
    { ...base, visibleToActor: "resp-b", limit: 100 },
    { ...base, visibleToActor: "disp-a", limit: 100 },
    { ...base, statuses: ["NEW", "TRIAGED"] },
    { ...base, statuses: ["COMPLETED", "CLOSED"], sort: "lastActivityAt", order: "desc" },
    { ...base, priorities: ["critical", "high"], sort: "status" },
    { ...base, assigneeId: UNASSIGNED, limit: 100 },
    { ...base, assigneeId: "resp-c", limit: 100 },
    { ...base, facilityId: "fac-b", limit: 100 },
    { ...base, subjectId: "RES-3", limit: 100 },
    { ...base, escalated: true, limit: 100 },
    { ...base, escalated: false, limit: 100 },
    { ...base, createdFrom: "2026-11-01T10:00:00.000Z", createdTo: "2026-11-02T06:00:00.000Z", limit: 100 },
    { ...base, activityFrom: "2026-11-02T00:00:00.000Z", sort: "lastActivityAt", limit: 100 },
    { ...base, query: "case-01", limit: 100 },
    { ...base, query: "res-4", limit: 100 },
    { ...base, query: "FALL", limit: 100 },
    { ...base, query: "転倒", limit: 100 },
    { ...base, query: "UNWELL", statuses: [...CASE_STATUSES], limit: 100 },
    { ...base, query: "nothing-matches" },
    { ...base, offset: 500 },
    { ...base, facilityScope: ["fac-a"], visibleToActor: "resp-a", statuses: ["IN_PROGRESS", "HANDOFF_PENDING", "ASSIGNED"], priorities: ["normal", "low", "high"], sort: "priority", order: "desc", limit: 3, offset: 1 },
  );
  return queries;
}

const summarize = (result: { total: number; cases: Array<{ aggregate: { id: string } }> }) => ({
  total: result.total,
  ids: result.cases.map((item) => item.aggregate.id),
});

test("Case search: SQLite matches the in-memory reference for every query", async () => {
  const tenantId = "tenant-parity";
  const memory = new InMemoryCaseRepository();
  const { database, stores } = createSqliteStores(":memory:");
  for (const { events } of syntheticDataset(tenantId)) {
    for (const repository of [memory, stores.repository]) {
      await repository.create(events[0] as Extract<CaseEvent, { type: "case_created" }>);
      for (const event of events.slice(1)) {
        await repository.append({ tenantId, caseId: (events[0] as Extract<CaseEvent, { type: "case_created" }>).data.caseId, expectedVersion: event.sequence - 1, event });
      }
    }
  }
  let nonEmpty = 0;
  for (const query of parityQueries(tenantId)) {
    const expected = summarize(await memory.search(query));
    if (expected.ids.length) nonEmpty += 1;
    assert.deepEqual(summarize(await stores.repository.search(query)), expected, JSON.stringify(query));
  }
  assert.ok(nonEmpty >= 20, "dataset exercises most queries");
  database.close();
});

const databaseUrl = process.env.DATABASE_URL;

test("Case search: PostgreSQL search_care_cases matches the in-memory reference", { skip: !databaseUrl }, async () => {
  const run = (sqlText: string) =>
    execFileSync("psql", [databaseUrl!, "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
      encoding: "utf8",
      input: sqlText,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  const json = (value: unknown) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
  const text = (value: string) => `'${value.replaceAll("'", "''")}'`;
  run("\\i tests/postgres/bootstrap.sql\n\\i db/case_store.sql\n");

  const tenantId = `tenant-parity-${Date.now()}`;
  const memory = new InMemoryCaseRepository();
  const statements: string[] = ["set role service_role;"];
  for (const { events } of syntheticDataset(tenantId)) {
    const createdEvent = events[0] as Extract<CaseEvent, { type: "case_created" }>;
    const caseId = createdEvent.data.caseId;
    const created = await memory.create(createdEvent);
    statements.push(`select public.create_care_case(${json(created.aggregate)}, ${json(createdEvent)});`);
    for (const event of events.slice(1)) {
      const aggregate = await memory.append({ tenantId, caseId, expectedVersion: event.sequence - 1, event });
      statements.push(`select public.append_care_case_event(${text(tenantId)}, ${text(caseId)}, ${event.sequence - 1}, ${json(aggregate)}, ${json(event)});`);
    }
  }
  run(statements.join("\n"));

  let nonEmpty = 0;
  for (const query of parityQueries(tenantId)) {
    const output = run(`set role service_role;\nselect public.search_care_cases(${text(tenantId)}, ${json(caseSearchRpcPayload(query))})::text;`);
    const raw = JSON.parse(output.split("\n").at(-1)!);
    const actual = { total: raw.total, ids: raw.cases.map((item: { caseId: string }) => item.caseId) };
    if (actual.ids.length) nonEmpty += 1;
    assert.deepEqual(actual, summarize(await memory.search(query)), JSON.stringify(query));
  }
  assert.ok(nonEmpty >= 20, `PostgreSQL returned rows for ${nonEmpty} queries`);
});
