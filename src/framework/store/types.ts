import type {
  CaseManualLink,
  CaseStepCheck,
  TrainingAttempt,
  FrameworkManual,
  FrameworkManualVersion,
  ManualSearchHit,
  ManualVersionStatus,
  TenantProfile,
} from "../types.ts";

/** Normalized search fields computed by the service (single normalization path). */
export interface ManualWrite extends FrameworkManual {
  search: { title: string; tags: string };
}

export interface ManualVersionWrite extends FrameworkManualVersion {
  search: { summary: string; steps: string };
}

export interface VersionTransition {
  tenantId: string;
  manualId: string;
  version: number;
  from: ManualVersionStatus;
  to: ManualVersionStatus;
  actorId: string;
  at: string;
  effectiveUntil?: string | null;
}

export interface FieldSearchQuery {
  terms: string[];
  category: string | null;
  limit: number;
}

/**
 * Tenant-scoped Framework persistence. Every method takes the tenant explicitly;
 * implementations must never resolve a record by ID alone.
 * Write methods are compare-and-set; conflicts raise FrameworkConflictError.
 */
export interface FrameworkStore {
  getTenantProfile(tenantId: string): Promise<TenantProfile | null>;
  putTenantProfile(profile: TenantProfile): Promise<void>;

  createManual(manual: ManualWrite, first: ManualVersionWrite): Promise<void>;
  getManual(tenantId: string, manualId: string): Promise<FrameworkManual | null>;
  listManuals(tenantId: string): Promise<FrameworkManual[]>;
  listVersions(tenantId: string, manualId: string): Promise<FrameworkManualVersion[]>;
  getVersion(tenantId: string, manualId: string, version: number): Promise<FrameworkManualVersion | null>;
  addVersion(version: ManualVersionWrite): Promise<void>;
  transitionVersion(transition: VersionTransition): Promise<void>;

  /** Approved, currently effective versions only. */
  searchFieldManuals(tenantId: string, query: FieldSearchQuery, now: string): Promise<ManualSearchHit[]>;

  linkCase(link: CaseManualLink): Promise<{ created: boolean }>;
  getCaseLink(tenantId: string, caseId: string): Promise<CaseManualLink | null>;
  /** Signal IDs are unique per tenant across Framework links (retry detection). */
  getCaseLinkBySignal(tenantId: string, signalId: string): Promise<CaseManualLink | null>;

  /** Append-only; the same attemptId with identical identity is an idempotent replay. */
  recordTrainingAttempt(attempt: TrainingAttempt): Promise<{ created: boolean; attempt: TrainingAttempt }>;
  listTrainingAttempts(tenantId: string, filter: TrainingAttemptFilter): Promise<TrainingAttempt[]>;

  /** Idempotent per tenant + case + step; returns the first check. */
  recordStepCheck(check: CaseStepCheck): Promise<{ created: boolean; check: CaseStepCheck }>;
  listStepChecks(tenantId: string, caseId: string): Promise<CaseStepCheck[]>;
}

export interface TrainingAttemptFilter {
  actorIds?: string[];
  manualId?: string;
  limit: number;
}
