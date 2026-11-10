import { DatabaseSync, type SQLOutputValue } from "node:sqlite";

import { applyEvent, replayCase } from "../src/core/case-core.ts";
import { CaseConflictError } from "../src/core/errors.ts";
import type {
  CaseAggregate,
  CaseCreatedEvent,
  CaseEvent,
} from "../src/core/types.ts";
import type {
  ClaimOutboxInput,
  CompleteOutboxInput,
  EnqueueOutboxInput,
  EnqueueOutboxResult,
  FailOutboxInput,
  FailOutboxResult,
  OutboxMessage,
  OutboxStatus,
} from "../src/outbox/types.ts";
import {
  CaseNotFoundError,
  CaseStoreCorruptionError,
  DuplicateCaseError,
  SignalReplayMismatchError,
} from "../src/persistence/errors.ts";
import type {
  AppendCaseEventInput,
  CaseRepository,
  CreateCaseResult,
  StoredCase,
} from "../src/persistence/types.ts";
import type {
  ListableOutboxStore,
  OutboxListEntry,
} from "../src/careops/in-memory-stores.ts";
import type {
  AiDraft,
  AiDraftStatus,
  AiDraftStore,
  AuditLogStore,
  FacilitySettings,
  FacilitySettingsStore,
  PlatformAuditEntry,
  SignalDisposition,
  SignalListFilter,
  SignalRecord,
  SignalStore,
  StaffNotification,
  StaffNotificationInbox,
} from "../src/careops/types.ts";

/**
 * Local persistence for the CareOps development environment, built on the
 * Node.js built-in SQLite driver. It mirrors the guarantees of the
 * Postgres contract (tenant-scoped keys, signal idempotency, compare-and-
 * set appends, append-only events, snapshot/replay verification).
 *
 * Production persistence remains Postgres/Supabase (db/*.sql).
 */

const SCHEMA = `
pragma journal_mode = wal;
pragma foreign_keys = on;

create table if not exists care_cases (
  tenant_id text not null,
  case_id text not null,
  source_adapter text not null,
  source_signal_id text not null,
  version integer not null check (version >= 1),
  snapshot text not null,
  primary key (tenant_id, case_id),
  unique (tenant_id, source_adapter, source_signal_id)
);

create table if not exists care_case_events (
  tenant_id text not null,
  case_id text not null,
  sequence integer not null check (sequence >= 1),
  event text not null,
  primary key (tenant_id, case_id, sequence),
  foreign key (tenant_id, case_id) references care_cases (tenant_id, case_id) on delete restrict
);

create trigger if not exists care_case_events_append_only_update
  before update on care_case_events
  begin select raise(abort, 'care_case_events is append-only'); end;
create trigger if not exists care_case_events_append_only_delete
  before delete on care_case_events
  begin select raise(abort, 'care_case_events is append-only'); end;

create table if not exists care_signals (
  tenant_id text not null,
  id text not null,
  source_adapter text not null,
  source_signal_id text not null,
  disposition text not null,
  case_id text,
  received_at text not null,
  record text not null,
  primary key (tenant_id, id),
  unique (tenant_id, source_adapter, source_signal_id)
);

create table if not exists care_facility_settings (
  tenant_id text not null,
  facility_id text not null,
  version integer not null,
  settings text not null,
  primary key (tenant_id, facility_id)
);

create table if not exists care_audit_log (
  id text primary key,
  tenant_id text not null,
  at text not null,
  target_id text not null,
  entry text not null
);
create trigger if not exists care_audit_log_append_only_update
  before update on care_audit_log
  begin select raise(abort, 'care_audit_log is append-only'); end;
create trigger if not exists care_audit_log_append_only_delete
  before delete on care_audit_log
  begin select raise(abort, 'care_audit_log is append-only'); end;

create table if not exists care_ai_drafts (
  tenant_id text not null,
  id text not null,
  case_id text not null,
  status text not null,
  generated_at text not null,
  draft text not null,
  primary key (tenant_id, id)
);

create table if not exists care_outbox (
  id integer primary key autoincrement,
  tenant_id text not null,
  topic text not null,
  delivery_key text not null,
  payload text not null,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  max_attempts integer not null default 8,
  available_at text not null,
  claimed_at text,
  lease_until text,
  worker_id text,
  last_error text,
  delivered_at text,
  unique (tenant_id, delivery_key)
);

create table if not exists care_staff_notifications (
  tenant_id text not null,
  delivery_key text not null,
  created_at text not null,
  notification text not null,
  primary key (tenant_id, delivery_key)
);
`;

function str(value: SQLOutputValue | undefined): string {
  if (typeof value !== "string") throw new CaseStoreCorruptionError("Expected text column");
  return value;
}

function num(value: SQLOutputValue | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new CaseStoreCorruptionError("Expected integer column");
}

function parse<T>(value: SQLOutputValue | undefined): T {
  return JSON.parse(str(value)) as T;
}

export class CareOpsSqliteDatabase {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  transaction<T>(work: () => T): T {
    this.db.exec("begin immediate");
    try {
      const result = work();
      this.db.exec("commit");
      return result;
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}

/* ------------------------------ Cases ------------------------------- */

export class SqliteCaseRepository implements CaseRepository {
  readonly #store: CareOpsSqliteDatabase;

  constructor(store: CareOpsSqliteDatabase) {
    this.#store = store;
  }

  #events(tenantId: string, caseId: string): CaseEvent[] {
    return this.#store.db
      .prepare("select event from care_case_events where tenant_id = ? and case_id = ? order by sequence")
      .all(tenantId, caseId)
      .map((row) => parse<CaseEvent>(row.event));
  }

  #verified(tenantId: string, caseId: string, snapshot: CaseAggregate, events: CaseEvent[]): StoredCase {
    if (snapshot.tenantId !== tenantId || snapshot.id !== caseId || events.length === 0) {
      throw new CaseStoreCorruptionError(`Stored Case identity mismatch: ${tenantId}/${caseId}`);
    }
    if (JSON.stringify(replayCase(events)) !== JSON.stringify(snapshot)) {
      throw new CaseStoreCorruptionError(`Stored Case snapshot/event divergence: ${tenantId}/${caseId}`);
    }
    return { aggregate: snapshot, events };
  }

  async create(event: CaseCreatedEvent): Promise<CreateCaseResult> {
    const { tenantId, caseId, sourceAdapter, sourceSignalId } = event.data;
    return this.#store.transaction(() => {
      const existing = this.#store.db
        .prepare("select case_id, snapshot from care_cases where tenant_id = ? and source_adapter = ? and source_signal_id = ?")
        .get(tenantId, sourceAdapter, sourceSignalId);
      if (existing) {
        const aggregate = parse<CaseAggregate>(existing.snapshot);
        if (aggregate.subjectId !== event.data.subjectId || aggregate.sourceType !== event.data.sourceType) {
          throw new SignalReplayMismatchError(tenantId, sourceAdapter, sourceSignalId);
        }
        const original = this.#events(tenantId, str(existing.case_id))[0];
        if (!original || original.type !== "case_created") {
          throw new CaseStoreCorruptionError("Stored Case is missing case_created event");
        }
        return { aggregate, event: original, created: false };
      }
      if (this.#store.db.prepare("select 1 from care_cases where tenant_id = ? and case_id = ?").get(tenantId, caseId)) {
        throw new DuplicateCaseError(tenantId, caseId);
      }
      const aggregate = replayCase([event]);
      this.#store.db
        .prepare("insert into care_cases (tenant_id, case_id, source_adapter, source_signal_id, version, snapshot) values (?, ?, ?, ?, ?, ?)")
        .run(tenantId, caseId, sourceAdapter, sourceSignalId, 1, JSON.stringify(aggregate));
      this.#store.db
        .prepare("insert into care_case_events (tenant_id, case_id, sequence, event) values (?, ?, ?, ?)")
        .run(tenantId, caseId, 1, JSON.stringify(event));
      return { aggregate, event, created: true };
    });
  }

  async load(tenantId: string, caseId: string): Promise<StoredCase | null> {
    const row = this.#store.db
      .prepare("select snapshot from care_cases where tenant_id = ? and case_id = ?")
      .get(tenantId, caseId);
    if (!row) return null;
    return this.#verified(tenantId, caseId, parse<CaseAggregate>(row.snapshot), this.#events(tenantId, caseId));
  }

  async list(tenantId: string): Promise<StoredCase[]> {
    const rows = this.#store.db
      .prepare("select case_id, snapshot from care_cases where tenant_id = ? order by case_id")
      .all(tenantId);
    const events = new Map<string, CaseEvent[]>();
    for (const row of this.#store.db
      .prepare("select case_id, event from care_case_events where tenant_id = ? order by case_id, sequence")
      .all(tenantId)) {
      const caseId = str(row.case_id);
      const list = events.get(caseId) ?? [];
      list.push(parse<CaseEvent>(row.event));
      events.set(caseId, list);
    }
    return rows.map((row) => {
      const caseId = str(row.case_id);
      return this.#verified(tenantId, caseId, parse<CaseAggregate>(row.snapshot), events.get(caseId) ?? []);
    });
  }

  async append(input: AppendCaseEventInput): Promise<CaseAggregate> {
    return this.#store.transaction(() => {
      const row = this.#store.db
        .prepare("select version, snapshot from care_cases where tenant_id = ? and case_id = ?")
        .get(input.tenantId, input.caseId);
      if (!row) throw new CaseNotFoundError(input.tenantId, input.caseId);
      const version = num(row.version);
      if (version !== input.expectedVersion) {
        throw new CaseConflictError(input.expectedVersion, version);
      }
      const next = applyEvent(parse<CaseAggregate>(row.snapshot), input.event);
      if (next.tenantId !== input.tenantId || next.id !== input.caseId) {
        throw new CaseNotFoundError(input.tenantId, input.caseId);
      }
      const updated = this.#store.db
        .prepare("update care_cases set version = ?, snapshot = ? where tenant_id = ? and case_id = ? and version = ?")
        .run(next.version, JSON.stringify(next), input.tenantId, input.caseId, input.expectedVersion);
      if (Number(updated.changes) !== 1) throw new CaseConflictError(input.expectedVersion, version);
      this.#store.db
        .prepare("insert into care_case_events (tenant_id, case_id, sequence, event) values (?, ?, ?, ?)")
        .run(input.tenantId, input.caseId, input.event.sequence, JSON.stringify(input.event));
      return next;
    });
  }
}

/* ----------------------------- Signals ------------------------------ */

export class SqliteSignalStore implements SignalStore {
  readonly #store: CareOpsSqliteDatabase;
  constructor(store: CareOpsSqliteDatabase) { this.#store = store; }

  async findBySource(tenantId: string, sourceAdapter: string, sourceSignalId: string) {
    const row = this.#store.db
      .prepare("select record from care_signals where tenant_id = ? and source_adapter = ? and source_signal_id = ?")
      .get(tenantId, sourceAdapter, sourceSignalId);
    return row ? parse<SignalRecord>(row.record) : null;
  }

  async get(tenantId: string, id: string) {
    const row = this.#store.db.prepare("select record from care_signals where tenant_id = ? and id = ?").get(tenantId, id);
    return row ? parse<SignalRecord>(row.record) : null;
  }

  async insert(record: SignalRecord) {
    return this.#store.transaction(() => {
      const existing = this.#store.db
        .prepare("select record from care_signals where tenant_id = ? and source_adapter = ? and source_signal_id = ?")
        .get(record.tenantId, record.sourceAdapter, record.sourceSignalId);
      if (existing) return { record: parse<SignalRecord>(existing.record), created: false };
      this.#store.db
        .prepare("insert into care_signals (tenant_id, id, source_adapter, source_signal_id, disposition, case_id, received_at, record) values (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(record.tenantId, record.id, record.sourceAdapter, record.sourceSignalId, record.disposition, record.caseId, record.receivedAt, JSON.stringify(record));
      return { record, created: true };
    });
  }

  async updateDisposition(record: SignalRecord, expected: SignalDisposition) {
    return this.#store.transaction(() => {
      const row = this.#store.db.prepare("select record from care_signals where tenant_id = ? and id = ? and disposition = ?").get(record.tenantId, record.id, expected);
      if (!row) return false;
      const current = parse<SignalRecord>(row.record);
      const next: SignalRecord = {
        ...record,
        sourceAdapter: current.sourceAdapter,
        sourceSignalId: current.sourceSignalId,
        receivedAt: current.receivedAt,
        rawText: current.rawText,
        replayCount: current.replayCount,
      };
      this.#store.db
        .prepare("update care_signals set disposition = ?, case_id = ?, record = ? where tenant_id = ? and id = ? and disposition = ?")
        .run(next.disposition, next.caseId, JSON.stringify(next), record.tenantId, record.id, expected);
      return true;
    });
  }

  async incrementReplay(tenantId: string, id: string) {
    this.#store.transaction(() => {
      const row = this.#store.db.prepare("select record from care_signals where tenant_id = ? and id = ?").get(tenantId, id);
      if (!row) return;
      const current = parse<SignalRecord>(row.record);
      current.replayCount += 1;
      this.#store.db.prepare("update care_signals set record = ? where tenant_id = ? and id = ?").run(JSON.stringify(current), tenantId, id);
    });
  }

  async list(tenantId: string, filter: SignalListFilter = {}) {
    return this.#store.db
      .prepare(
        "select record from care_signals where tenant_id = ? and (? is null or disposition = ?) and (? is null or case_id = ?) order by received_at desc",
      )
      .all(tenantId, filter.disposition ?? null, filter.disposition ?? null, filter.caseId ?? null, filter.caseId ?? null)
      .map((row) => parse<SignalRecord>(row.record));
  }
}

/* ---------------------------- Settings ------------------------------ */

export class SqliteFacilitySettingsStore implements FacilitySettingsStore {
  readonly #store: CareOpsSqliteDatabase;
  constructor(store: CareOpsSqliteDatabase) { this.#store = store; }

  async get(tenantId: string, facilityId: string) {
    const row = this.#store.db.prepare("select settings from care_facility_settings where tenant_id = ? and facility_id = ?").get(tenantId, facilityId);
    return row ? parse<FacilitySettings>(row.settings) : null;
  }

  async list(tenantId: string) {
    return this.#store.db
      .prepare("select settings from care_facility_settings where tenant_id = ? order by facility_id")
      .all(tenantId)
      .map((row) => parse<FacilitySettings>(row.settings));
  }

  async save(settings: FacilitySettings, expectedVersion: number) {
    return this.#store.transaction(() => {
      if (expectedVersion === 0) {
        const exists = this.#store.db.prepare("select 1 from care_facility_settings where tenant_id = ? and facility_id = ?").get(settings.tenantId, settings.facilityId);
        if (exists) return false;
        this.#store.db
          .prepare("insert into care_facility_settings (tenant_id, facility_id, version, settings) values (?, ?, ?, ?)")
          .run(settings.tenantId, settings.facilityId, settings.version, JSON.stringify(settings));
        return true;
      }
      const result = this.#store.db
        .prepare("update care_facility_settings set version = ?, settings = ? where tenant_id = ? and facility_id = ? and version = ?")
        .run(settings.version, JSON.stringify(settings), settings.tenantId, settings.facilityId, expectedVersion);
      return Number(result.changes) === 1;
    });
  }
}

/* ------------------------------ Audit ------------------------------- */

export class SqliteAuditLogStore implements AuditLogStore {
  readonly #store: CareOpsSqliteDatabase;
  constructor(store: CareOpsSqliteDatabase) { this.#store = store; }

  async append(entry: PlatformAuditEntry) {
    this.#store.db
      .prepare("insert into care_audit_log (id, tenant_id, at, target_id, entry) values (?, ?, ?, ?, ?)")
      .run(entry.id, entry.tenantId, entry.at, entry.targetId, JSON.stringify(entry));
  }

  async list(tenantId: string, options: { targetId?: string; limit?: number } = {}) {
    return this.#store.db
      .prepare("select entry from care_audit_log where tenant_id = ? and (? is null or target_id = ?) order by at desc limit ?")
      .all(tenantId, options.targetId ?? null, options.targetId ?? null, options.limit ?? 500)
      .map((row) => parse<PlatformAuditEntry>(row.entry));
  }
}

/* ----------------------------- AI drafts ---------------------------- */

export class SqliteAiDraftStore implements AiDraftStore {
  readonly #store: CareOpsSqliteDatabase;
  constructor(store: CareOpsSqliteDatabase) { this.#store = store; }

  async insert(draft: AiDraft) {
    this.#store.db
      .prepare("insert into care_ai_drafts (tenant_id, id, case_id, status, generated_at, draft) values (?, ?, ?, ?, ?, ?)")
      .run(draft.tenantId, draft.id, draft.caseId, draft.status, draft.generatedAt, JSON.stringify(draft));
  }

  async get(tenantId: string, id: string) {
    const row = this.#store.db.prepare("select draft from care_ai_drafts where tenant_id = ? and id = ?").get(tenantId, id);
    return row ? parse<AiDraft>(row.draft) : null;
  }

  async update(draft: AiDraft, expectedStatus: AiDraftStatus) {
    return this.#store.transaction(() => {
      const row = this.#store.db.prepare("select draft from care_ai_drafts where tenant_id = ? and id = ? and status = ?").get(draft.tenantId, draft.id, expectedStatus);
      if (!row) return false;
      const current = parse<AiDraft>(row.draft);
      const next: AiDraft = {
        ...draft,
        content: current.content,
        provider: current.provider,
        model: current.model,
        generatedAt: current.generatedAt,
        sources: current.sources,
      };
      this.#store.db
        .prepare("update care_ai_drafts set status = ?, draft = ? where tenant_id = ? and id = ? and status = ?")
        .run(next.status, JSON.stringify(next), draft.tenantId, draft.id, expectedStatus);
      return true;
    });
  }

  async listByCase(tenantId: string, caseId: string) {
    return this.#store.db
      .prepare("select draft from care_ai_drafts where tenant_id = ? and case_id = ? order by generated_at desc")
      .all(tenantId, caseId)
      .map((row) => parse<AiDraft>(row.draft));
  }
}

/* ------------------------------ Outbox ------------------------------ */

function outboxRow(row: Record<string, SQLOutputValue>): OutboxListEntry {
  const nullable = (value: SQLOutputValue | undefined) => (value === null || value === undefined ? null : str(value));
  return {
    id: num(row.id),
    tenantId: str(row.tenant_id),
    topic: str(row.topic),
    deliveryKey: str(row.delivery_key),
    payload: parse<unknown>(row.payload),
    status: str(row.status) as OutboxStatus,
    attemptCount: num(row.attempt_count),
    maxAttempts: num(row.max_attempts),
    availableAt: str(row.available_at),
    claimedAt: nullable(row.claimed_at),
    leaseUntil: nullable(row.lease_until),
    workerId: nullable(row.worker_id),
    lastError: nullable(row.last_error),
    deliveredAt: nullable(row.delivered_at),
  };
}

export class SqliteOutboxStore implements ListableOutboxStore {
  readonly #store: CareOpsSqliteDatabase;
  readonly #now: () => string;

  constructor(store: CareOpsSqliteDatabase, now: () => string = () => new Date().toISOString()) {
    this.#store = store;
    this.#now = now;
  }

  async enqueue(input: EnqueueOutboxInput): Promise<EnqueueOutboxResult> {
    return this.#store.transaction(() => {
      const existing = this.#store.db.prepare("select id, topic, payload from care_outbox where tenant_id = ? and delivery_key = ?").get(input.tenantId, input.deliveryKey);
      if (existing) {
        if (str(existing.topic) !== input.topic || str(existing.payload) !== JSON.stringify(input.payload)) {
          throw new Error("Outbox delivery key reused with a different payload");
        }
        return { created: false, id: num(existing.id) };
      }
      const result = this.#store.db
        .prepare("insert into care_outbox (tenant_id, topic, delivery_key, payload, max_attempts, available_at) values (?, ?, ?, ?, ?, ?)")
        .run(input.tenantId, input.topic, input.deliveryKey, JSON.stringify(input.payload), input.maxAttempts ?? 8, input.availableAt ?? this.#now());
      return { created: true, id: Number(result.lastInsertRowid) };
    });
  }

  async claim(input: ClaimOutboxInput): Promise<OutboxMessage[]> {
    const now = this.#now();
    const lease = new Date(Date.parse(now) + (input.leaseSeconds ?? 60) * 1000).toISOString();
    return this.#store.transaction(() => {
      this.#store.db
        .prepare("update care_outbox set status = 'dead_letter', worker_id = null, lease_until = null where tenant_id = ? and status = 'processing' and lease_until < ? and attempt_count >= max_attempts")
        .run(input.tenantId, now);
      const candidates = this.#store.db
        .prepare(
          "select id from care_outbox where tenant_id = ? and attempt_count < max_attempts and ((status in ('pending','failed') and available_at <= ?) or (status = 'processing' and lease_until < ?)) order by available_at, id limit ?",
        )
        .all(input.tenantId, now, now, input.limit ?? 50);
      const claimed: OutboxMessage[] = [];
      for (const candidate of candidates) {
        this.#store.db
          .prepare("update care_outbox set status = 'processing', attempt_count = attempt_count + 1, claimed_at = ?, lease_until = ?, worker_id = ? where id = ?")
          .run(now, lease, input.workerId, num(candidate.id));
        const row = this.#store.db.prepare("select * from care_outbox where id = ?").get(num(candidate.id))!;
        claimed.push(outboxRow(row));
      }
      return claimed;
    });
  }

  async complete(input: CompleteOutboxInput): Promise<boolean> {
    const result = this.#store.db
      .prepare("update care_outbox set status = 'delivered', delivered_at = ?, lease_until = null, last_error = null where tenant_id = ? and id = ? and status = 'processing' and worker_id = ?")
      .run(this.#now(), input.tenantId, input.id, input.workerId);
    return Number(result.changes) === 1;
  }

  async fail(input: FailOutboxInput): Promise<FailOutboxResult> {
    return this.#store.transaction(() => {
      const row = this.#store.db
        .prepare("select attempt_count, max_attempts from care_outbox where tenant_id = ? and id = ? and status = 'processing' and worker_id = ?")
        .get(input.tenantId, input.id, input.workerId);
      if (!row) return { ok: false, status: null };
      const status: OutboxStatus = num(row.attempt_count) >= num(row.max_attempts) ? "dead_letter" : "failed";
      this.#store.db
        .prepare("update care_outbox set status = ?, available_at = case when ? = 'failed' then ? else available_at end, worker_id = null, lease_until = null, last_error = ? where id = ?")
        .run(status, status, input.retryAt ?? this.#now(), input.error.slice(0, 1000), input.id);
      return { ok: true, status };
    });
  }

  async list(tenantId: string, limit = 200): Promise<OutboxListEntry[]> {
    return this.#store.db
      .prepare("select * from care_outbox where tenant_id = ? order by id desc limit ?")
      .all(tenantId, limit)
      .map(outboxRow);
  }
}

/* -------------------------- Notifications --------------------------- */

export class SqliteStaffNotificationInbox implements StaffNotificationInbox {
  readonly #store: CareOpsSqliteDatabase;
  constructor(store: CareOpsSqliteDatabase) { this.#store = store; }

  async deliver(notification: StaffNotification) {
    const result = this.#store.db
      .prepare("insert or ignore into care_staff_notifications (tenant_id, delivery_key, created_at, notification) values (?, ?, ?, ?)")
      .run(notification.tenantId, notification.deliveryKey, notification.createdAt, JSON.stringify(notification));
    return Number(result.changes) === 1;
  }

  async list(tenantId: string, limit = 100) {
    return this.#store.db
      .prepare("select notification from care_staff_notifications where tenant_id = ? order by created_at desc limit ?")
      .all(tenantId, limit)
      .map((row) => parse<StaffNotification>(row.notification));
  }
}

export function createSqliteStores(path: string, now: () => string = () => new Date().toISOString()) {
  const database = new CareOpsSqliteDatabase(path);
  return {
    database,
    stores: {
      repository: new SqliteCaseRepository(database),
      signals: new SqliteSignalStore(database),
      settings: new SqliteFacilitySettingsStore(database),
      audit: new SqliteAuditLogStore(database),
      drafts: new SqliteAiDraftStore(database),
      outbox: new SqliteOutboxStore(database, now),
      inbox: new SqliteStaffNotificationInbox(database),
    },
  };
}
