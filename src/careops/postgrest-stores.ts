import { isOperationalActorId } from "../access/actor-id.ts";
import { STAFF_ROLES, type StaffRole, type TenantMembership } from "../access/types.ts";
import { outboundAbortSignal, outboundTimeoutMs } from "../outbound.ts";
import type { OutboxStatus } from "../outbox/types.ts";
import { PostgrestOutboxStore } from "../outbox/postgrest-outbox-store.ts";
import {
  CaseStoreCorruptionError,
  CaseStoreTransportError,
} from "../persistence/errors.ts";
import type { ListableOutboxStore, OutboxListEntry } from "./in-memory-stores.ts";
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
} from "./types.ts";

/**
 * PostgREST (Supabase Data API) adapters for the CareOps platform stores.
 * Server-only: they use the service-role key. Reads use table SELECT
 * (service_role has SELECT only); every write goes through the
 * security-definer RPCs in db/careops_platform.sql (ADR 0016).
 */

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface PostgrestStoreOptions {
  baseUrl: string;
  serviceRoleKey: string;
  fetchImpl?: FetchLike;
  requestTimeoutMs?: number;
  pageSize?: number;
}

export class PostgrestJsonClient {
  readonly #baseUrl: string;
  readonly #key: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly pageSize: number;

  constructor(options: PostgrestStoreOptions) {
    const base = options.baseUrl.trim();
    if (!base) throw new Error("PostgREST base URL is required");
    if (!options.serviceRoleKey.trim()) throw new Error("service-role key is required");
    this.#baseUrl = base.endsWith("/") ? base.slice(0, -1) : base;
    this.#key = options.serviceRoleKey.trim();
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = outboundTimeoutMs(options.requestTimeoutMs);
    this.pageSize = options.pageSize ?? 500;
    if (!Number.isInteger(this.pageSize) || this.pageSize < 1 || this.pageSize > 1000) {
      throw new Error("pageSize must be between 1 and 1000");
    }
  }

  async #request(url: URL, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(url, {
        ...init,
        headers: {
          apikey: this.#key,
          authorization: `Bearer ${this.#key}`,
          accept: "application/json",
          "content-type": "application/json",
          "accept-profile": "public",
          "content-profile": "public",
        },
        signal: outboundAbortSignal(this.#timeoutMs),
      });
    } catch (error) {
      // Never include request bodies (care data) in errors.
      throw new CaseStoreTransportError(
        `CareOps store request failed: ${error instanceof Error ? error.name : "network error"}`,
      );
    }
    const raw = await response.text();
    if (!response.ok) {
      throw new CaseStoreTransportError(`CareOps store returned HTTP ${response.status}`, response.status);
    }
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      throw new CaseStoreTransportError("CareOps store returned non-JSON response", response.status);
    }
  }

  async rpc(name: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await this.#request(new URL(`${this.#baseUrl}/rest/v1/rpc/${encodeURIComponent(name)}`), {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new CaseStoreCorruptionError(`RPC ${name} returned an invalid object`);
    }
    return result as Record<string, unknown>;
  }

  /** GET rows with server-side filters, following pagination up to `max`. */
  async select<T>(table: string, params: Record<string, string>, max = Number.POSITIVE_INFINITY): Promise<T[]> {
    const rows: T[] = [];
    for (let offset = 0; rows.length < max; offset += this.pageSize) {
      const url = new URL(`${this.#baseUrl}/rest/v1/${encodeURIComponent(table)}`);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      const limit = Math.min(this.pageSize, max - rows.length);
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("offset", String(offset));
      const body = await this.#request(url, { method: "GET" });
      if (!Array.isArray(body)) throw new CaseStoreCorruptionError(`${table} list is not an array`);
      rows.push(...(body as T[]));
      if (body.length < limit) break;
    }
    return rows;
  }
}

function jsonColumn<T>(row: unknown, column: string, guard: (value: Record<string, unknown>) => boolean): T {
  const value = (row as Record<string, unknown> | null)?.[column];
  if (!value || typeof value !== "object" || Array.isArray(value) || !guard(value as Record<string, unknown>)) {
    throw new CaseStoreCorruptionError(`Stored ${column} is invalid`);
  }
  return structuredClone(value) as T;
}

const eq = (value: string) => `eq.${value}`;
const isSignal = (value: Record<string, unknown>) =>
  typeof value.id === "string" && typeof value.tenantId === "string" && typeof value.disposition === "string";

export class PostgrestSignalStore implements SignalStore {
  readonly #client: PostgrestJsonClient;
  constructor(client: PostgrestJsonClient) { this.#client = client; }

  #one(rows: unknown[]): SignalRecord | null {
    return rows[0] ? jsonColumn<SignalRecord>(rows[0], "record", isSignal) : null;
  }

  async findBySource(tenantId: string, sourceAdapter: string, sourceSignalId: string) {
    return this.#one(await this.#client.select("care_signals", {
      select: "record", tenant_id: eq(tenantId), source_adapter: eq(sourceAdapter), source_signal_id: eq(sourceSignalId),
    }, 1));
  }

  async get(tenantId: string, id: string) {
    return this.#one(await this.#client.select("care_signals", { select: "record", tenant_id: eq(tenantId), id: eq(id) }, 1));
  }

  async insert(record: SignalRecord) {
    const result = await this.#client.rpc("record_care_signal", { p_record: record });
    if (result.ok !== true) throw new CaseStoreCorruptionError("record_care_signal failed");
    return {
      record: jsonColumn<SignalRecord>(result, "record", isSignal),
      created: result.created === true,
    };
  }

  async updateDisposition(record: SignalRecord, expected: SignalDisposition) {
    const result = await this.#client.rpc("decide_care_signal", {
      p_tenant_id: record.tenantId, p_id: record.id, p_expected_disposition: expected, p_record: record,
    });
    return result.ok === true;
  }

  async incrementReplay(tenantId: string, id: string) {
    await this.#client.rpc("increment_care_signal_replay", { p_tenant_id: tenantId, p_id: id });
  }

  async list(tenantId: string, filter: SignalListFilter = {}) {
    const params: Record<string, string> = { select: "record", tenant_id: eq(tenantId), order: "received_at.desc,id.asc" };
    if (filter.disposition) params.disposition = eq(filter.disposition);
    if (filter.caseId) params.case_id = eq(filter.caseId);
    if (filter.receivedFrom && filter.receivedTo) {
      params.and = `(received_at.gte."${filter.receivedFrom}",received_at.lt."${filter.receivedTo}")`;
    } else if (filter.receivedFrom) {
      params.received_at = `gte.${filter.receivedFrom}`;
    } else if (filter.receivedTo) {
      params.received_at = `lt.${filter.receivedTo}`;
    }
    const rows = await this.#client.select("care_signals", params);
    return rows.map((row) => jsonColumn<SignalRecord>(row, "record", isSignal));
  }
}

const isSettings = (value: Record<string, unknown>) =>
  typeof value.facilityId === "string" && typeof value.version === "number" && typeof value.sla === "object";

export class PostgrestFacilitySettingsStore implements FacilitySettingsStore {
  readonly #client: PostgrestJsonClient;
  constructor(client: PostgrestJsonClient) { this.#client = client; }

  async get(tenantId: string, facilityId: string) {
    const rows = await this.#client.select("care_facility_settings", { select: "settings", tenant_id: eq(tenantId), facility_id: eq(facilityId) }, 1);
    return rows[0] ? jsonColumn<FacilitySettings>(rows[0], "settings", isSettings) : null;
  }

  async list(tenantId: string) {
    const rows = await this.#client.select("care_facility_settings", { select: "settings", tenant_id: eq(tenantId), order: "facility_id.asc" });
    return rows.map((row) => jsonColumn<FacilitySettings>(row, "settings", isSettings));
  }

  async save(settings: FacilitySettings, expectedVersion: number) {
    const result = await this.#client.rpc("save_care_facility_settings", { p_settings: settings, p_expected_version: expectedVersion });
    return result.ok === true;
  }
}

const isAudit = (value: Record<string, unknown>) => typeof value.id === "string" && typeof value.action === "string";

export class PostgrestAuditLogStore implements AuditLogStore {
  readonly #client: PostgrestJsonClient;
  constructor(client: PostgrestJsonClient) { this.#client = client; }

  async append(entry: PlatformAuditEntry) {
    const result = await this.#client.rpc("append_care_platform_audit", { p_entry: entry });
    if (result.ok !== true) throw new CaseStoreCorruptionError("append_care_platform_audit failed");
  }

  async list(tenantId: string, options: { targetId?: string; limit?: number } = {}) {
    const params: Record<string, string> = { select: "entry", tenant_id: eq(tenantId), order: "at.desc,id.asc" };
    if (options.targetId) params.target_id = eq(options.targetId);
    const rows = await this.#client.select("care_platform_audit_log", params, options.limit ?? 500);
    return rows.map((row) => jsonColumn<PlatformAuditEntry>(row, "entry", isAudit));
  }
}

const isDraft = (value: Record<string, unknown>) =>
  typeof value.id === "string" && typeof value.caseId === "string" && typeof value.status === "string";

export class PostgrestAiDraftStore implements AiDraftStore {
  readonly #client: PostgrestJsonClient;
  constructor(client: PostgrestJsonClient) { this.#client = client; }

  async insert(draft: AiDraft) {
    const result = await this.#client.rpc("insert_care_ai_draft", { p_draft: draft });
    if (result.ok !== true) throw new CaseStoreCorruptionError("insert_care_ai_draft failed");
  }

  async get(tenantId: string, id: string) {
    const rows = await this.#client.select("care_ai_drafts", { select: "draft", tenant_id: eq(tenantId), id: eq(id) }, 1);
    return rows[0] ? jsonColumn<AiDraft>(rows[0], "draft", isDraft) : null;
  }

  async update(draft: AiDraft, expectedStatus: AiDraftStatus) {
    const result = await this.#client.rpc("review_care_ai_draft", {
      p_tenant_id: draft.tenantId, p_id: draft.id, p_expected_status: expectedStatus, p_draft: draft,
    });
    return result.ok === true;
  }

  async listByCase(tenantId: string, caseId: string) {
    const rows = await this.#client.select("care_ai_drafts", { select: "draft", tenant_id: eq(tenantId), case_id: eq(caseId), order: "generated_at.desc,id.asc" });
    return rows.map((row) => jsonColumn<AiDraft>(row, "draft", isDraft));
  }
}

const isNotification = (value: Record<string, unknown>) => typeof value.deliveryKey === "string" && typeof value.caseId === "string";

export class PostgrestStaffNotificationInbox implements StaffNotificationInbox {
  readonly #client: PostgrestJsonClient;
  constructor(client: PostgrestJsonClient) { this.#client = client; }

  async deliver(notification: StaffNotification) {
    const result = await this.#client.rpc("deliver_care_staff_notification", { p_notification: notification });
    return result.created === true;
  }

  async list(tenantId: string, limit = 100) {
    const rows = await this.#client.select("care_staff_notifications", { select: "notification", tenant_id: eq(tenantId), order: "created_at.desc,delivery_key.asc" }, limit);
    return rows.map((row) => jsonColumn<StaffNotification>(row, "notification", isNotification));
  }
}

interface OutboxRow {
  id: number; tenant_id: string; topic: string; delivery_key: string; payload: unknown; status: OutboxStatus;
  attempt_count: number; max_attempts: number; available_at: string; claimed_at: string | null;
  lease_until: string | null; worker_id: string | null; last_error: string | null; delivered_at: string | null;
}

/** Existing PostgrestOutboxStore (enqueue/claim/complete/fail RPCs) plus a read-only listing. */
export class PostgrestListableOutboxStore extends PostgrestOutboxStore implements ListableOutboxStore {
  readonly #client: PostgrestJsonClient;

  constructor(options: PostgrestStoreOptions, client: PostgrestJsonClient) {
    super({
      baseUrl: options.baseUrl,
      serviceRoleKey: options.serviceRoleKey,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.requestTimeoutMs ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
    });
    this.#client = client;
  }

  async list(tenantId: string, limit = 200): Promise<OutboxListEntry[]> {
    const rows = await this.#client.select<OutboxRow>("care_outbox", {
      select: "id,tenant_id,topic,delivery_key,payload,status,attempt_count,max_attempts,available_at,claimed_at,lease_until,worker_id,last_error,delivered_at",
      tenant_id: eq(tenantId),
      order: "id.desc",
    }, limit);
    return rows.map((row) => ({
      id: row.id, tenantId: row.tenant_id, topic: row.topic, deliveryKey: row.delivery_key,
      payload: structuredClone(row.payload), status: row.status, attemptCount: row.attempt_count,
      maxAttempts: row.max_attempts, availableAt: row.available_at, claimedAt: row.claimed_at,
      leaseUntil: row.lease_until, workerId: row.worker_id, lastError: row.last_error, deliveredAt: row.delivered_at,
    }));
  }
}

interface MembershipRow {
  tenant_id: unknown; principal_id: unknown; actor_id: unknown; roles: unknown; active: unknown; facility_ids: unknown;
}

/** Roster listing for assignment pickers (actor-level data only). */
export async function listTenantMemberships(client: PostgrestJsonClient, tenantId: string): Promise<TenantMembership[]> {
  const rows = await client.select<MembershipRow>("care_tenant_memberships", {
    select: "tenant_id,principal_id,actor_id,roles,active,facility_ids",
    tenant_id: eq(tenantId),
    order: "actor_id.asc",
  });
  return rows.map((row) => {
    if (
      typeof row.tenant_id !== "string" || typeof row.principal_id !== "string" ||
      typeof row.actor_id !== "string" || !isOperationalActorId(row.actor_id) ||
      typeof row.active !== "boolean" || !Array.isArray(row.roles) ||
      row.roles.some((role) => !STAFF_ROLES.includes(role as StaffRole)) ||
      (row.facility_ids !== null && row.facility_ids !== undefined && !Array.isArray(row.facility_ids))
    ) {
      throw new CaseStoreCorruptionError("Tenant membership row is invalid");
    }
    const facilityIds = Array.isArray(row.facility_ids) && row.facility_ids.length ? (row.facility_ids as string[]) : undefined;
    return {
      tenantId: row.tenant_id,
      principalId: row.principal_id,
      actorId: row.actor_id,
      roles: row.roles as StaffRole[],
      active: row.active,
      ...(facilityIds ? { facilityIds } : {}),
    };
  });
}

export function createPostgrestPlatformStores(options: PostgrestStoreOptions) {
  const client = new PostgrestJsonClient(options);
  return {
    client,
    signals: new PostgrestSignalStore(client),
    settings: new PostgrestFacilitySettingsStore(client),
    audit: new PostgrestAuditLogStore(client),
    drafts: new PostgrestAiDraftStore(client),
    inbox: new PostgrestStaffNotificationInbox(client),
    outbox: new PostgrestListableOutboxStore(options, client),
  };
}
