import { outboundAbortSignal, outboundTimeoutMs } from "../../outbound.ts";
import {
  FrameworkConflictError,
  FrameworkGovernanceError,
  FrameworkStoreUnavailableError,
  type FrameworkConflictReason,
} from "../errors.ts";
import type {
  CaseManualLink,
  CaseStepCheck,
  FrameworkManual,
  FrameworkManualVersion,
  ManualSearchHit,
  TenantProfile,
  TrainingAttempt,
} from "../types.ts";
import type {
  TrainingAttemptFilter,
  FieldSearchQuery,
  FrameworkStore,
  ManualVersionWrite,
  ManualWrite,
  VersionTransition,
} from "./types.ts";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface PostgrestFrameworkStoreOptions {
  baseUrl: string;
  serviceRoleKey: string;
  fetchImpl?: FetchLike;
  requestTimeoutMs?: number;
}

const CONFLICTS: readonly FrameworkConflictReason[] = [
  "manual_exists",
  "open_revision_exists",
  "version_status_changed",
  "manual_version_stale",
  "case_link_mismatch",
  "training_attempt_exists",
  "step_check_exists",
  "case_closed",
];

/**
 * Server-only adapter for db/framework_store.sql through PostgREST.
 * Every call is a single-object RPC (`{ p_payload }`); the database performs
 * the compare-and-set, so concurrent writers cannot overwrite each other.
 * Never construct this in a browser: it carries the service-role key.
 */
export class PostgrestFrameworkStore implements FrameworkStore {
  private readonly baseUrl: string;
  private readonly serviceRoleKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: PostgrestFrameworkStoreOptions) {
    const base = options.baseUrl.trim();
    if (!base) throw new Error("PostgREST base URL is required");
    if (!options.serviceRoleKey.trim()) throw new Error("service role key is required");
    this.baseUrl = base.endsWith("/") ? base.slice(0, -1) : base;
    this.serviceRoleKey = options.serviceRoleKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = outboundTimeoutMs(options.requestTimeoutMs);
  }

  /** Calls an RPC and returns its JSON object result. Transport and HTTP failures are 503-class. */
  protected async rpc(name: string, payload: unknown): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(`${this.baseUrl}/rest/v1/rpc/${encodeURIComponent(name)}`), {
        method: "POST",
        headers: {
          apikey: this.serviceRoleKey,
          authorization: `Bearer ${this.serviceRoleKey}`,
          accept: "application/json",
          "content-type": "application/json",
          "accept-profile": "public",
          "content-profile": "public",
        },
        body: JSON.stringify({ p_payload: payload }),
        signal: outboundAbortSignal(this.timeoutMs),
      });
    } catch {
      throw new FrameworkStoreUnavailableError("Framework store request failed");
    }
    const raw = await response.text();
    if (!response.ok) throw new FrameworkStoreUnavailableError(`Framework store returned HTTP ${response.status}`);
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      throw new FrameworkStoreUnavailableError("Framework store returned non-JSON response");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new FrameworkStoreUnavailableError("Framework store returned an unexpected shape");
    }
    const result = body as Record<string, unknown>;
    if (typeof result.conflict === "string") {
      if (!(CONFLICTS as readonly string[]).includes(result.conflict)) {
        throw new FrameworkStoreUnavailableError("Framework store returned an unknown conflict");
      }
      throw new FrameworkConflictError(result.conflict as FrameworkConflictReason);
    }
    if (result.governance === "self_review") throw new FrameworkGovernanceError("self_review");
    return result;
  }

  private static array<T>(value: unknown): T[] {
    if (!Array.isArray(value)) throw new FrameworkStoreUnavailableError("Expected an array");
    return value as T[];
  }

  async getTenantProfile(tenantId: string) {
    return ((await this.rpc("framework_get_tenant_profile", { tenantId })).profile ?? null) as TenantProfile | null;
  }

  async putTenantProfile(profile: TenantProfile) {
    await this.rpc("framework_put_tenant_profile", profile);
  }

  async createManual(manual: ManualWrite, first: ManualVersionWrite) {
    await this.rpc("framework_create_manual", { manual, version: first });
  }

  async getManual(tenantId: string, manualId: string) {
    return ((await this.rpc("framework_get_manual", { tenantId, manualId })).manual ?? null) as FrameworkManual | null;
  }

  async listManuals(tenantId: string) {
    return PostgrestFrameworkStore.array<FrameworkManual>((await this.rpc("framework_list_manuals", { tenantId })).manuals);
  }

  async listVersions(tenantId: string, manualId: string) {
    return PostgrestFrameworkStore.array<FrameworkManualVersion>(
      (await this.rpc("framework_list_versions", { tenantId, manualId })).versions,
    ).map(normalizeVersion);
  }

  async getVersion(tenantId: string, manualId: string, version: number) {
    const found = (await this.rpc("framework_get_version", { tenantId, manualId, version })).version;
    return found ? normalizeVersion(found as FrameworkManualVersion) : null;
  }

  async addVersion(version: ManualVersionWrite) {
    await this.rpc("framework_add_manual_version", { version });
  }

  async transitionVersion(transition: VersionTransition) {
    await this.rpc("framework_transition_manual_version", transition);
  }

  async searchFieldManuals(tenantId: string, query: FieldSearchQuery, now: string) {
    return PostgrestFrameworkStore.array<ManualSearchHit>(
      (await this.rpc("framework_search_manuals", { tenantId, terms: query.terms, category: query.category, limit: query.limit, now })).hits,
    );
  }

  async linkCase(link: CaseManualLink) {
    const result = await this.rpc("framework_link_case", { link });
    return { created: result.created === true };
  }

  async getCaseLink(tenantId: string, caseId: string) {
    return ((await this.rpc("framework_get_case_link", { tenantId, caseId })).link ?? null) as CaseManualLink | null;
  }

  async getCaseLinkBySignal(tenantId: string, signalId: string) {
    return ((await this.rpc("framework_get_case_link", { tenantId, signalId })).link ?? null) as CaseManualLink | null;
  }

  async recordTrainingAttempt(attempt: TrainingAttempt) {
    const result = await this.rpc("framework_record_training_attempt", { attempt });
    return { created: result.created === true, attempt: normalizeAttempt(result.attempt as TrainingAttempt) };
  }

  async listTrainingAttempts(tenantId: string, filter: TrainingAttemptFilter) {
    return PostgrestFrameworkStore.array<TrainingAttempt>(
      (await this.rpc("framework_list_training_attempts", { tenantId, ...filter })).attempts,
    ).map(normalizeAttempt);
  }

  async recordStepCheck(check: CaseStepCheck) {
    const result = await this.rpc("framework_record_step_check", { check });
    return { created: result.created === true, check: normalizeCheck(result.check as CaseStepCheck) };
  }

  async listStepChecks(tenantId: string, caseId: string) {
    return PostgrestFrameworkStore.array<CaseStepCheck>(
      (await this.rpc("framework_list_step_checks", { tenantId, caseId })).checks,
    ).map(normalizeCheck);
  }
}

function normalizeAttempt(attempt: TrainingAttempt): TrainingAttempt {
  return { ...attempt, completedAt: isoOrNull(attempt.completedAt) ?? attempt.completedAt };
}

function normalizeCheck(check: CaseStepCheck): CaseStepCheck {
  return { ...check, checkedAt: isoOrNull(check.checkedAt) ?? check.checkedAt };
}

/** PostgreSQL returns timestamptz as `2026-11-21T13:10:00+00:00`; keep ISO-8601 `Z` form. */
export function isoOrNull(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

function normalizeVersion(version: FrameworkManualVersion): FrameworkManualVersion {
  return {
    ...version,
    createdAt: isoOrNull(version.createdAt) ?? version.createdAt,
    submittedAt: isoOrNull(version.submittedAt),
    reviewedAt: isoOrNull(version.reviewedAt),
    effectiveFrom: isoOrNull(version.effectiveFrom),
    effectiveUntil: isoOrNull(version.effectiveUntil),
  };
}
