import { isOpenCaseStatus } from "../core/case-core.ts";
import {
  CASE_PRIORITIES,
  CASE_STATUSES,
  type CaseAggregate,
  type CaseEvent,
  type CasePriority,
  type CaseStatus,
} from "../core/types.ts";
import {
  evaluateCaseSla,
  type CaseSlaEvaluation,
  type CaseSlaPolicy,
  type SlaStage,
} from "../operations/sla.ts";
import type { StoredCase } from "../persistence/types.ts";

export type SlaPolicyResolver = (facilityId: string | null) => CaseSlaPolicy;

export interface CareOpsCaseListItem {
  caseId: string;
  facilityId: string | null;
  subjectId: string;
  category: string | null;
  sourceType: string;
  priority: CasePriority;
  priorityRationale: string | null;
  status: CaseStatus;
  assigneeId: string | null;
  handoffTargetId: string | null;
  createdAt: string;
  lastActivityAt: string;
  lastCheckedAt: string | null;
  escalated: boolean;
  /** critical and still unacknowledged: a human must look now. */
  needsHumanReview: boolean;
  /** Assignee or handoff target can no longer act on this Case. */
  assigneeUnavailable: boolean;
  hasActiveBreach: boolean;
  breachedStages: SlaStage[];
  currentStage: SlaStage | null;
  nextDeadlineAt: string | null;
  reopenedCount: number;
  linkedSignalCount: number;
  version: number;
}

export const CASE_SORT_KEYS = [
  "attention",
  "createdAt",
  "lastActivityAt",
  "priority",
  "status",
  "nextDeadlineAt",
] as const;

export type CaseSortKey = (typeof CASE_SORT_KEYS)[number];

export interface CaseListFilter {
  statuses?: CaseStatus[];
  priorities?: CasePriority[];
  assigneeId?: string;
  /** "__unassigned__" filters Cases without an assignee. */
  facilityId?: string;
  escalated?: boolean;
  breached?: boolean;
  openOnly?: boolean;
  createdFrom?: string;
  createdTo?: string;
  query?: string;
  sort?: CaseSortKey;
  order?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

export interface CaseListPage {
  items: CareOpsCaseListItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  evaluatedAt: string;
}

export const UNASSIGNED_FILTER = "__unassigned__";
export const MAX_PAGE_SIZE = 100;

const PRIORITY_RANK: Record<CasePriority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

const STATUS_RANK = Object.fromEntries(
  CASE_STATUSES.map((status, index) => [status, index]),
) as Record<CaseStatus, number>;

export function evaluateStoredCaseSla(
  stored: StoredCase,
  policyFor: SlaPolicyResolver,
  now: string,
): CaseSlaEvaluation {
  return evaluateCaseSla(
    stored.aggregate,
    stored.events,
    policyFor(stored.aggregate.facilityId ?? null),
    now,
  );
}

/** true when the actor can currently act on Cases of the facility. */
export type AvailabilityCheck = (actorId: string, facilityId: string | null) => boolean;

export function hasUnavailableOwner(
  aggregate: CaseAggregate,
  isAvailable: AvailabilityCheck | undefined,
): boolean {
  if (!isAvailable || !isOpenCaseStatus(aggregate.status)) return false;
  const facilityId = aggregate.facilityId ?? null;
  return Boolean(
    (aggregate.assigneeId && !isAvailable(aggregate.assigneeId, facilityId)) ||
    (aggregate.handoffTargetId && !isAvailable(aggregate.handoffTargetId, facilityId)),
  );
}

export function toCaseListItem(
  stored: StoredCase,
  policyFor: SlaPolicyResolver,
  now: string,
  isAvailable?: AvailabilityCheck,
): CareOpsCaseListItem {
  const aggregate = stored.aggregate;
  const sla = evaluateStoredCaseSla(stored, policyFor, now);

  return {
    caseId: aggregate.id,
    facilityId: aggregate.facilityId ?? null,
    subjectId: aggregate.subjectId,
    category: aggregate.category ?? null,
    sourceType: aggregate.sourceType,
    priority: aggregate.priority,
    priorityRationale: aggregate.priorityRationale ?? null,
    status: aggregate.status,
    assigneeId: aggregate.assigneeId,
    handoffTargetId: aggregate.handoffTargetId,
    createdAt: aggregate.createdAt,
    lastActivityAt: aggregate.lastActivityAt ?? aggregate.createdAt,
    lastCheckedAt: aggregate.lastCheckedAt ?? null,
    escalated: Boolean(aggregate.escalation),
    needsHumanReview: aggregate.priority === "critical" && aggregate.status === "NEW",
    assigneeUnavailable: hasUnavailableOwner(aggregate, isAvailable),
    hasActiveBreach: sla.hasActiveBreach,
    breachedStages: [...sla.breachedStages],
    currentStage: sla.currentStage,
    nextDeadlineAt: sla.nextDeadlineAt,
    reopenedCount: aggregate.reopenedCount,
    linkedSignalCount: aggregate.linkedSignalCount ?? 0,
    version: aggregate.version,
  };
}

function timeMs(value: string | null): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function compareAttention(a: CareOpsCaseListItem, b: CareOpsCaseListItem): number {
  const openA = isOpenCaseStatus(a.status) ? 0 : 1;
  const openB = isOpenCaseStatus(b.status) ? 0 : 1;
  if (openA !== openB) return openA - openB;
  if (a.needsHumanReview !== b.needsHumanReview) return a.needsHumanReview ? -1 : 1;
  if (a.assigneeUnavailable !== b.assigneeUnavailable) return a.assigneeUnavailable ? -1 : 1;
  if (a.hasActiveBreach !== b.hasActiveBreach) return a.hasActiveBreach ? -1 : 1;
  if (a.escalated !== b.escalated) return a.escalated ? -1 : 1;
  const priority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (priority !== 0) return priority;
  const deadline = timeMs(a.nextDeadlineAt) - timeMs(b.nextDeadlineAt);
  if (deadline !== 0 && Number.isFinite(deadline)) return deadline;
  return timeMs(a.createdAt) - timeMs(b.createdAt);
}

function compareBy(key: CaseSortKey) {
  return (a: CareOpsCaseListItem, b: CareOpsCaseListItem): number => {
    switch (key) {
      case "attention":
        return compareAttention(a, b);
      case "createdAt":
        return timeMs(a.createdAt) - timeMs(b.createdAt);
      case "lastActivityAt":
        return timeMs(a.lastActivityAt) - timeMs(b.lastActivityAt);
      case "priority":
        return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
      case "status":
        return STATUS_RANK[a.status] - STATUS_RANK[b.status];
      case "nextDeadlineAt": {
        const ta = timeMs(a.nextDeadlineAt);
        const tb = timeMs(b.nextDeadlineAt);
        if (ta === tb) return 0;
        return ta < tb ? -1 : 1;
      }
    }
  };
}

export function searchCases(
  cases: readonly StoredCase[],
  filter: CaseListFilter,
  policyFor: SlaPolicyResolver,
  now: string,
  isAvailable?: AvailabilityCheck,
): CaseListPage {
  const pageSize = Math.min(Math.max(1, Math.trunc(filter.pageSize ?? 20)), MAX_PAGE_SIZE);
  const query = filter.query?.trim().toLowerCase() ?? "";
  const fromMs = filter.createdFrom ? Date.parse(filter.createdFrom) : null;
  const toMs = filter.createdTo ? Date.parse(filter.createdTo) : null;

  const items = cases
    .map((stored) => toCaseListItem(stored, policyFor, now, isAvailable))
    .filter((item) => !filter.statuses?.length || filter.statuses.includes(item.status))
    .filter((item) => !filter.priorities?.length || filter.priorities.includes(item.priority))
    .filter((item) => !filter.openOnly || isOpenCaseStatus(item.status))
    .filter((item) => {
      if (!filter.assigneeId) return true;
      if (filter.assigneeId === UNASSIGNED_FILTER) return item.assigneeId === null;
      return item.assigneeId === filter.assigneeId || item.handoffTargetId === filter.assigneeId;
    })
    .filter((item) => !filter.facilityId || item.facilityId === filter.facilityId)
    .filter((item) => filter.escalated === undefined || item.escalated === filter.escalated)
    .filter((item) => filter.breached === undefined || item.hasActiveBreach === filter.breached)
    .filter((item) => fromMs === null || Date.parse(item.createdAt) >= fromMs)
    .filter((item) => toMs === null || Date.parse(item.createdAt) < toMs)
    .filter((item) => {
      if (!query) return true;
      return [item.caseId, item.subjectId, item.category ?? "", item.assigneeId ?? "", item.sourceType]
        .some((value) => value.toLowerCase().includes(query));
    });

  const comparator = compareBy(filter.sort ?? "attention");
  const direction = filter.order === "desc" ? -1 : 1;
  items.sort((a, b) => {
    const result = comparator(a, b) * direction;
    return result !== 0 ? result : a.caseId.localeCompare(b.caseId);
  });

  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.trunc(filter.page ?? 1)), totalPages);

  return {
    items: items.slice((page - 1) * pageSize, page * pageSize),
    page,
    pageSize,
    total,
    totalPages,
    evaluatedAt: now,
  };
}

/* ------------------------------------------------------------------ */
/* Dashboard                                                             */
/* ------------------------------------------------------------------ */

export interface CareOpsDashboard {
  evaluatedAt: string;
  facilityId: string | null;
  counts: {
    unacknowledged: number;
    unassigned: number;
    inProgress: number;
    handoffPending: number;
    resolved: number;
    closed: number;
    overdue: number;
    escalated: number;
    needsHumanReview: number;
    /** Open Cases whose assignee / handoff target can no longer act. */
    assigneeUnavailable: number;
    openTotal: number;
  };
  /**
   * Staff-notification delivery problems (supervisors only; null for
   * roles that may not see delivery status).
   */
  delivery: { failed: number; deadLetter: number } | null;
  byPriority: Record<CasePriority, number>;
  mine: {
    assigned: number;
    incomingHandoffs: number;
  };
  /** Most urgent open Cases for the landing view. */
  attention: CareOpsCaseListItem[];
  pendingSignals: number;
}

export function projectDashboard(input: {
  cases: readonly StoredCase[];
  policyFor: SlaPolicyResolver;
  now: string;
  actorId: string;
  facilityId: string | null;
  pendingSignals: number;
  isAvailable?: AvailabilityCheck;
  delivery?: { failed: number; deadLetter: number } | null;
}): CareOpsDashboard {
  const items = input.cases
    .map((stored) => toCaseListItem(stored, input.policyFor, input.now, input.isAvailable))
    .filter((item) => !input.facilityId || item.facilityId === input.facilityId);
  const open = items.filter((item) => isOpenCaseStatus(item.status));

  const byPriority = Object.fromEntries(
    CASE_PRIORITIES.map((priority) => [priority, 0]),
  ) as Record<CasePriority, number>;
  for (const item of open) byPriority[item.priority] += 1;

  return {
    evaluatedAt: input.now,
    facilityId: input.facilityId,
    counts: {
      unacknowledged: open.filter((item) => item.status === "NEW").length,
      unassigned: open.filter((item) => item.status === "ACKNOWLEDGED" || item.status === "TRIAGED").length,
      inProgress: open.filter((item) => item.status === "ASSIGNED" || item.status === "IN_PROGRESS").length,
      handoffPending: open.filter((item) => item.status === "HANDOFF_PENDING").length,
      resolved: items.filter((item) => item.status === "COMPLETED").length,
      closed: items.filter((item) => item.status === "CLOSED").length,
      overdue: open.filter((item) => item.hasActiveBreach).length,
      escalated: open.filter((item) => item.escalated).length,
      needsHumanReview: open.filter((item) => item.needsHumanReview).length,
      assigneeUnavailable: open.filter((item) => item.assigneeUnavailable).length,
      openTotal: open.length,
    },
    byPriority,
    mine: {
      assigned: open.filter((item) => item.assigneeId === input.actorId && item.status !== "HANDOFF_PENDING").length,
      incomingHandoffs: open.filter((item) => item.handoffTargetId === input.actorId).length,
    },
    attention: [...open].sort(compareAttention).slice(0, 8),
    pendingSignals: input.pendingSignals,
    delivery: input.delivery ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* Handoff board (引継ぎボード)                                           */
/* ------------------------------------------------------------------ */

export interface HandoffBoardItem {
  caseId: string;
  facilityId: string | null;
  priority: CasePriority;
  category: string | null;
  fromActorId: string | null;
  toActorId: string | null;
  note: string | null;
  requestedAt: string | null;
  waitingMinutes: number | null;
  overdue: boolean;
  version: number;
}

export interface HandoffHistoryItem {
  caseId: string;
  action: "handoff_accepted" | "handoff_declined" | "handoff_cancelled" | "reassigned";
  actorId: string | null;
  at: string;
  reason: string | null;
}

export interface ShiftEndItem {
  caseId: string;
  facilityId: string | null;
  priority: CasePriority;
  status: CaseStatus;
  category: string | null;
  lastActivityAt: string;
  version: number;
}

export interface HandoffBoard {
  evaluatedAt: string;
  incoming: HandoffBoardItem[];
  outgoing: HandoffBoardItem[];
  /** Every unaccepted handoff the operator can see (未受領). */
  unaccepted: HandoffBoardItem[];
  recent: HandoffHistoryItem[];
  /** Operator's own open Cases without a pending handoff (勤務終了前に要引継ぎ). */
  shiftEnd: ShiftEndItem[];
}

function minutesBetween(start: string | null, now: string): number | null {
  if (!start) return null;
  return Math.max(0, Math.floor((Date.parse(now) - Date.parse(start)) / 60_000));
}

function handoffItem(
  stored: StoredCase,
  policyFor: SlaPolicyResolver,
  now: string,
): HandoffBoardItem {
  const aggregate = stored.aggregate;
  const sla = evaluateStoredCaseSla(stored, policyFor, now);
  return {
    caseId: aggregate.id,
    facilityId: aggregate.facilityId ?? null,
    priority: aggregate.priority,
    category: aggregate.category ?? null,
    fromActorId: aggregate.assigneeId,
    toActorId: aggregate.handoffTargetId,
    note: aggregate.handoffNote ?? null,
    requestedAt: aggregate.handoffRequestedAt ?? null,
    waitingMinutes: minutesBetween(aggregate.handoffRequestedAt ?? null, now),
    overdue: sla.breachedStages.includes("handoff_accept"),
    version: aggregate.version,
  };
}

function reasonOf(event: CaseEvent): string | null {
  if (
    event.type === "handoff_declined" ||
    event.type === "handoff_cancelled" ||
    event.type === "reassigned"
  ) {
    return event.data.reason;
  }
  return null;
}

export function projectHandoffBoard(input: {
  cases: readonly StoredCase[];
  policyFor: SlaPolicyResolver;
  now: string;
  actorId: string;
  recentWindowHours?: number;
}): HandoffBoard {
  const pending = input.cases.filter((stored) => stored.aggregate.status === "HANDOFF_PENDING");
  const items = pending
    .map((stored) => handoffItem(stored, input.policyFor, input.now))
    .sort((a, b) => (b.waitingMinutes ?? 0) - (a.waitingMinutes ?? 0));
  const windowStart = Date.parse(input.now) - (input.recentWindowHours ?? 24) * 3_600_000;

  const recent: HandoffHistoryItem[] = [];
  for (const stored of input.cases) {
    for (const event of stored.events) {
      if (
        (event.type === "handoff_accepted" ||
          event.type === "handoff_declined" ||
          event.type === "handoff_cancelled" ||
          event.type === "reassigned") &&
        Date.parse(event.at) >= windowStart
      ) {
        recent.push({
          caseId: stored.aggregate.id,
          action: event.type,
          actorId: event.actorId,
          at: event.at,
          reason: reasonOf(event),
        });
      }
    }
  }
  recent.sort((a, b) => b.at.localeCompare(a.at));

  const shiftEnd = input.cases
    .map((stored) => stored.aggregate)
    .filter(
      (aggregate: CaseAggregate) =>
        aggregate.assigneeId === input.actorId &&
        (aggregate.status === "ASSIGNED" || aggregate.status === "IN_PROGRESS"),
    )
    .map((aggregate) => ({
      caseId: aggregate.id,
      facilityId: aggregate.facilityId ?? null,
      priority: aggregate.priority,
      status: aggregate.status,
      category: aggregate.category ?? null,
      lastActivityAt: aggregate.lastActivityAt ?? aggregate.createdAt,
      version: aggregate.version,
    }))
    .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);

  return {
    evaluatedAt: input.now,
    incoming: items.filter((item) => item.toActorId === input.actorId),
    outgoing: items.filter((item) => item.fromActorId === input.actorId),
    unaccepted: items,
    recent: recent.slice(0, 50),
    shiftEnd,
  };
}
