import { OPEN_CASE_STATUSES } from "../core/case-core.ts";
import {
  CASE_STATUSES,
  type CaseAggregate,
  type CasePriority,
  type CaseStatus,
} from "../core/types.ts";
import type { CaseRepository, StoredCase } from "./types.ts";

/**
 * Server-side Case search contract.
 *
 * Every adapter (in-memory reference, SQLite, PostgreSQL RPC
 * `search_care_cases`) must return exactly the same Cases in the same
 * order for the same query. Parity is enforced by contract tests.
 *
 * Visibility is part of the query so that unauthorised rows never leave
 * the database: `facilityScope` and `visibleToActor` are always derived
 * from the server-side membership, never from client input.
 */

export const CASE_SEARCH_SORTS = [
  "createdAt",
  "lastActivityAt",
  "priority",
  "status",
] as const;

export type CaseSearchSort = (typeof CASE_SEARCH_SORTS)[number];

export const UNASSIGNED = "__unassigned__";
export const MAX_SEARCH_LIMIT = 2000;

export interface CaseSearchQuery {
  tenantId: string;
  /** null = tenant-wide membership; otherwise only these facilities. */
  facilityScope: readonly string[] | null;
  /** Responder visibility: assignee, handoff target or creator only. */
  visibleToActor: string | null;
  statuses?: readonly CaseStatus[];
  priorities?: readonly CasePriority[];
  /** Matches assignee or handoff target; UNASSIGNED = no assignee. */
  assigneeId?: string;
  facilityId?: string;
  subjectId?: string;
  escalated?: boolean;
  createdFrom?: string;
  createdTo?: string;
  /** lastActivityAt >= activityFrom */
  activityFrom?: string;
  /** Case-insensitive substring over id, subject, category, assignee, source type. */
  query?: string;
  sort: CaseSearchSort;
  order: "asc" | "desc";
  limit: number;
  offset: number;
}

export interface CaseSearchResult {
  cases: StoredCase[];
  total: number;
}

export interface SearchableCaseRepository extends CaseRepository {
  search(query: CaseSearchQuery): Promise<CaseSearchResult>;
}

export function isSearchableCaseRepository(
  repository: CaseRepository,
): repository is SearchableCaseRepository {
  return typeof (repository as Partial<SearchableCaseRepository>).search === "function";
}

export const OPEN_STATUSES: readonly CaseStatus[] = OPEN_CASE_STATUSES;

const PRIORITY_RANK: Record<CasePriority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

const STATUS_RANK = Object.fromEntries(
  CASE_STATUSES.map((status, index) => [status, index]),
) as Record<CaseStatus, number>;

export function validateCaseSearchQuery(query: CaseSearchQuery): void {
  if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_SEARCH_LIMIT) {
    throw new Error(`limit must be between 1 and ${MAX_SEARCH_LIMIT}`);
  }
  if (!Number.isInteger(query.offset) || query.offset < 0) {
    throw new Error("offset must be a non-negative integer");
  }
  if (!CASE_SEARCH_SORTS.includes(query.sort)) throw new Error("unsupported sort");
  if (query.order !== "asc" && query.order !== "desc") throw new Error("unsupported order");
  if (query.facilityScope !== null && query.facilityScope.length === 0) {
    throw new Error("facilityScope must be null (tenant-wide) or non-empty");
  }
}

/** ASCII-only case folding: identical in SQLite lower() and PostgreSQL lower(x collate "C"). */
export function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (char) => char.toLowerCase());
}

/** Canonical timestamp form so string comparison in SQL equals time order. */
export function canonicalInstant(value: string): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error("invalid timestamp");
  return new Date(ms).toISOString();
}

export function caseMatchesSearch(aggregate: CaseAggregate, query: CaseSearchQuery): boolean {
  if (aggregate.tenantId !== query.tenantId) return false;
  const facilityId = aggregate.facilityId ?? null;
  if (query.facilityScope !== null && (facilityId === null || !query.facilityScope.includes(facilityId))) return false;
  if (
    query.visibleToActor !== null &&
    aggregate.assigneeId !== query.visibleToActor &&
    aggregate.handoffTargetId !== query.visibleToActor &&
    (aggregate.createdBy ?? null) !== query.visibleToActor
  ) {
    return false;
  }
  if (query.statuses?.length && !query.statuses.includes(aggregate.status)) return false;
  if (query.priorities?.length && !query.priorities.includes(aggregate.priority)) return false;
  if (query.assigneeId) {
    if (query.assigneeId === UNASSIGNED) {
      if (aggregate.assigneeId !== null) return false;
    } else if (aggregate.assigneeId !== query.assigneeId && aggregate.handoffTargetId !== query.assigneeId) {
      return false;
    }
  }
  if (query.facilityId && facilityId !== query.facilityId) return false;
  if (query.subjectId && aggregate.subjectId !== query.subjectId) return false;
  if (query.escalated !== undefined && Boolean(aggregate.escalation) !== query.escalated) return false;
  const created = Date.parse(aggregate.createdAt);
  if (query.createdFrom && created < Date.parse(query.createdFrom)) return false;
  if (query.createdTo && created >= Date.parse(query.createdTo)) return false;
  if (query.activityFrom && Date.parse(aggregate.lastActivityAt ?? aggregate.createdAt) < Date.parse(query.activityFrom)) return false;
  if (query.query) {
    const needle = asciiLower(query.query);
    const haystack = [aggregate.id, aggregate.subjectId, aggregate.category ?? "", aggregate.assigneeId ?? "", aggregate.sourceType];
    if (!haystack.some((value) => asciiLower(value).includes(needle))) return false;
  }
  return true;
}

export function compareCaseSearch(sort: CaseSearchSort, order: "asc" | "desc") {
  const direction = order === "desc" ? -1 : 1;
  return (a: CaseAggregate, b: CaseAggregate): number => {
    let result = 0;
    switch (sort) {
      case "createdAt":
        result = Date.parse(a.createdAt) - Date.parse(b.createdAt);
        break;
      case "lastActivityAt":
        result = Date.parse(a.lastActivityAt ?? a.createdAt) - Date.parse(b.lastActivityAt ?? b.createdAt);
        break;
      case "priority":
        result = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
        break;
      case "status":
        result = STATUS_RANK[a.status] - STATUS_RANK[b.status];
        break;
    }
    if (result !== 0) return result * direction;
    // Deterministic tie-breaker shared by every adapter (always ascending).
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
}

/** Reference implementation used by the in-memory repository. */
export function applyCaseSearch(
  cases: readonly StoredCase[],
  query: CaseSearchQuery,
): CaseSearchResult {
  validateCaseSearchQuery(query);
  const matched = cases
    .filter((stored) => caseMatchesSearch(stored.aggregate, query))
    .sort((a, b) => compareCaseSearch(query.sort, query.order)(a.aggregate, b.aggregate));
  return {
    total: matched.length,
    cases: matched.slice(query.offset, query.offset + query.limit),
  };
}
