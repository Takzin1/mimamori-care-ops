import { isOperationalActorId } from "../access/actor-id.ts";
import { STAFF_ROLES, type StaffRole } from "../access/types.ts";
import {
  CASE_PRIORITIES,
  CASE_STATUSES,
  SIGNAL_TYPES,
  type CasePriority,
  type CaseStatus,
  type SignalType,
} from "../core/types.ts";
import { HttpRequestError } from "../http/errors.ts";
import type { CaseSlaPolicy, SlaDurations } from "../operations/sla.ts";
import type {
  AiReviewInput,
  CaseFromSignalInput,
  ManualCaseInput,
  SettingsPatch,
  SignalIntakeInput,
} from "./platform-service.ts";
import { CASE_SORT_KEYS, type CaseListFilter, type CaseSortKey, UNASSIGNED_FILTER } from "./projections.ts";
import {
  AI_DRAFT_KINDS,
  SIGNAL_DISPOSITIONS,
  type AiDraftKind,
  type EscalationTrigger,
  type FacilityEscalationRule,
  type SignalDisposition,
} from "./types.ts";

type Rec = Record<string, unknown>;

export const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function invalid(message: string): never {
  throw new HttpRequestError(400, "INVALID_REQUEST", message);
}

function record(value: unknown, label: string): Rec {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`);
  return value as Rec;
}

function exactKeys(value: Rec, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) invalid(`${label} contains unsupported field: ${unknown}`);
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") invalid(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized) invalid(`${label} is required`);
  if (normalized.length > max) invalid(`${label} is too long`);
  return normalized;
}

function optText(value: unknown, label: string, max: number): string | undefined {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) return undefined;
  return text(value, label, max);
}

function safeId(value: unknown, label: string): string {
  const normalized = text(value, label, 128);
  if (!SAFE_ID.test(normalized)) invalid(`${label} has invalid format`);
  return normalized;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  const normalized = text(value, label, 64);
  if (!allowed.includes(normalized as T)) invalid(`${label} is not supported`);
  return normalized as T;
}

function positiveInt(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) invalid(`${label} must be a positive integer`);
  return value;
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") invalid(`${label} must be a boolean`);
  return value;
}

/* ------------------------------ queries ----------------------------- */

function isoParam(value: string | null, label: string): string | undefined {
  if (value === null || value === "") return undefined;
  if (value.length > 40 || !Number.isFinite(Date.parse(value))) invalid(`${label} must be an ISO date`);
  return new Date(Date.parse(value)).toISOString();
}

function listParam<T extends string>(value: string | null, allowed: readonly T[], label: string): T[] | undefined {
  if (!value) return undefined;
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (items.length > allowed.length) invalid(`${label} has too many values`);
  for (const item of items) if (!allowed.includes(item as T)) invalid(`${label} is not supported`);
  return items as T[];
}

function intParam(value: string | null, label: string, max: number): number | undefined {
  if (value === null || value === "") return undefined;
  if (!/^\d{1,6}$/.test(value)) invalid(`${label} must be a positive integer`);
  const parsed = Number(value);
  if (parsed < 1 || parsed > max) invalid(`${label} is out of range`);
  return parsed;
}

export function optionalFacilityParam(params: URLSearchParams): string | undefined {
  const value = params.get("facilityId");
  if (value === null || value === "") return undefined;
  if (!SAFE_ID.test(value)) invalid("facilityId has invalid format");
  return value;
}

export function parseCaseListQuery(params: URLSearchParams): CaseListFilter {
  const assignee = params.get("assigneeId");
  if (assignee && assignee !== UNASSIGNED_FILTER && !isOperationalActorId(assignee)) invalid("assigneeId has invalid format");
  const query = params.get("q");
  if (query && query.length > 100) invalid("q is too long");
  const flag = (name: string) => {
    const value = params.get(name);
    if (value === null || value === "") return undefined;
    if (value !== "true" && value !== "false") invalid(`${name} must be true or false`);
    return value === "true";
  };
  const sort = params.get("sort");
  const order = params.get("order");
  if (order && order !== "asc" && order !== "desc") invalid("order must be asc or desc");

  const filter: CaseListFilter = {};
  const statuses = listParam<CaseStatus>(params.get("status"), CASE_STATUSES, "status");
  const priorities = listParam<CasePriority>(params.get("priority"), CASE_PRIORITIES, "priority");
  const facilityId = optionalFacilityParam(params);
  const escalated = flag("escalated");
  const breached = flag("breached");
  const openOnly = flag("open");
  const createdFrom = isoParam(params.get("from"), "from");
  const createdTo = isoParam(params.get("to"), "to");
  const page = intParam(params.get("page"), "page", 100_000);
  const pageSize = intParam(params.get("pageSize"), "pageSize", 100);
  if (statuses) filter.statuses = statuses;
  if (priorities) filter.priorities = priorities;
  if (assignee) filter.assigneeId = assignee;
  if (facilityId) filter.facilityId = facilityId;
  if (escalated !== undefined) filter.escalated = escalated;
  if (breached !== undefined) filter.breached = breached;
  if (openOnly !== undefined) filter.openOnly = openOnly;
  if (createdFrom) filter.createdFrom = createdFrom;
  if (createdTo) filter.createdTo = createdTo;
  if (query) filter.query = query;
  if (sort) filter.sort = oneOf<CaseSortKey>(sort, CASE_SORT_KEYS, "sort");
  if (order) filter.order = order as "asc" | "desc";
  if (page) filter.page = page;
  if (pageSize) filter.pageSize = pageSize;
  return filter;
}

export function parseAnalyticsQuery(params: URLSearchParams): { from: string; to: string; facilityId?: string } {
  const from = isoParam(params.get("from"), "from");
  const to = isoParam(params.get("to"), "to");
  if (!from || !to) invalid("from and to are required");
  if (Date.parse(to) - Date.parse(from) > 366 * 86_400_000) invalid("period must not exceed 366 days");
  const facilityId = optionalFacilityParam(params);
  return { from, to, ...(facilityId ? { facilityId } : {}) };
}

export function parseSignalListQuery(params: URLSearchParams): SignalDisposition | undefined {
  const value = params.get("disposition");
  if (!value) return undefined;
  return oneOf<SignalDisposition>(value, SIGNAL_DISPOSITIONS, "disposition");
}

export function parseLimit(params: URLSearchParams): number | undefined {
  return intParam(params.get("limit"), "limit", 1000);
}

/* ------------------------------- bodies ----------------------------- */

export function parseManualCase(body: unknown): ManualCaseInput {
  const value = record(body, "request");
  exactKeys(value, ["facilityId", "subjectId", "sourceType", "priority", "category", "priorityRationale", "rawText"], "request");
  const category = optText(value.category, "category", 64);
  const priorityRationale = optText(value.priorityRationale, "priorityRationale", 1000);
  const rawText = optText(value.rawText, "rawText", 4000);
  return {
    facilityId: safeId(value.facilityId, "facilityId"),
    subjectId: safeId(value.subjectId, "subjectId"),
    sourceType: oneOf<SignalType>(value.sourceType, SIGNAL_TYPES, "sourceType"),
    priority: oneOf<CasePriority>(value.priority, CASE_PRIORITIES, "priority"),
    ...(category ? { category } : {}),
    ...(priorityRationale ? { priorityRationale } : {}),
    ...(rawText ? { rawText } : {}),
  };
}

export function parseSignalIntake(body: unknown): SignalIntakeInput {
  const value = record(body, "request");
  exactKeys(value, ["facilityId", "sourceAdapter", "sourceSignalId", "sourceType", "subjectId", "rawText", "priorityHint"], "request");
  const rawText = optText(value.rawText, "rawText", 4000);
  const priorityHint = value.priorityHint === undefined || value.priorityHint === null
    ? undefined
    : oneOf<CasePriority>(value.priorityHint, CASE_PRIORITIES, "priorityHint");
  return {
    facilityId: safeId(value.facilityId, "facilityId"),
    sourceAdapter: safeId(value.sourceAdapter, "sourceAdapter"),
    sourceSignalId: safeId(value.sourceSignalId, "sourceSignalId"),
    sourceType: oneOf<SignalType>(value.sourceType, SIGNAL_TYPES, "sourceType"),
    subjectId: safeId(value.subjectId, "subjectId"),
    ...(rawText ? { rawText } : {}),
    ...(priorityHint ? { priorityHint } : {}),
  };
}

export function parseCaseFromSignal(body: unknown): CaseFromSignalInput {
  const value = record(body, "request");
  exactKeys(value, ["priority", "category", "priorityRationale"], "request");
  const category = optText(value.category, "category", 64);
  const priorityRationale = optText(value.priorityRationale, "priorityRationale", 1000);
  return {
    priority: oneOf<CasePriority>(value.priority, CASE_PRIORITIES, "priority"),
    ...(category ? { category } : {}),
    ...(priorityRationale ? { priorityRationale } : {}),
  };
}

export function parseReason(body: unknown): string {
  const value = record(body, "request");
  exactKeys(value, ["reason"], "request");
  return text(value.reason, "reason", 1000);
}

export function parseAiDraftRequest(body: unknown): AiDraftKind {
  const value = record(body, "request");
  exactKeys(value, ["kind"], "request");
  return oneOf<AiDraftKind>(value.kind, AI_DRAFT_KINDS, "kind");
}

export function parseAiReview(body: unknown): AiReviewInput {
  const value = record(body, "request");
  exactKeys(value, ["decision", "text", "note", "acknowledgeUnverified", "expectedVersion"], "request");
  const reviewText = optText(value.text, "text", 4000);
  const note = optText(value.note, "note", 1000);
  return {
    decision: oneOf(value.decision, ["approve", "reject"] as const, "decision"),
    expectedVersion: positiveInt(value.expectedVersion, "expectedVersion"),
    ...(reviewText ? { text: reviewText } : {}),
    ...(note ? { note } : {}),
    ...(value.acknowledgeUnverified !== undefined ? { acknowledgeUnverified: bool(value.acknowledgeUnverified, "acknowledgeUnverified") } : {}),
  };
}

const SLA_KEYS: readonly (keyof SlaDurations)[] = [
  "acknowledgeWithinMs",
  "assignWithinMs",
  "firstActionWithinMs",
  "handoffAcceptWithinMs",
  "completeWithinMs",
];
const ESCALATION_TRIGGERS: readonly EscalationTrigger[] = [
  "critical_unacknowledged",
  "acknowledge",
  "assign",
  "first_action",
  "handoff_accept",
  "complete",
];
const MAX_SLA_MS = 7 * 86_400_000;

function parseSla(value: unknown): CaseSlaPolicy {
  const policy = record(value, "sla");
  exactKeys(policy, CASE_PRIORITIES, "sla");
  const result = {} as CaseSlaPolicy;
  for (const priority of CASE_PRIORITIES) {
    const rule = record(policy[priority], `sla.${priority}`);
    exactKeys(rule, SLA_KEYS, `sla.${priority}`);
    const durations = {} as SlaDurations;
    for (const key of SLA_KEYS) {
      const ms = rule[key];
      if (typeof ms !== "number" || !Number.isInteger(ms) || ms < 60_000 || ms > MAX_SLA_MS) {
        invalid(`sla.${priority}.${key} must be between 1 minute and 7 days (ms)`);
      }
      durations[key] = ms;
    }
    result[priority] = durations;
  }
  return result;
}

export function parseSettingsUpdate(body: unknown): { expectedVersion: number; patch: SettingsPatch } {
  const value = record(body, "request");
  exactKeys(value, ["expectedVersion", "displayName", "sla", "approveSla", "escalationRules", "autoCreateCaseFor", "linkDuplicateSignals", "categories"], "request");
  const patch: SettingsPatch = {};
  if (value.displayName !== undefined) patch.displayName = text(value.displayName, "displayName", 100);
  if (value.sla !== undefined) patch.sla = parseSla(value.sla);
  if (value.approveSla !== undefined) {
    const approve = record(value.approveSla, "approveSla");
    exactKeys(approve, ["note"], "approveSla");
    const note = optText(approve.note, "approveSla.note", 500);
    patch.approveSla = note ? { note } : {};
  }
  if (value.escalationRules !== undefined) {
    if (!Array.isArray(value.escalationRules) || value.escalationRules.length > ESCALATION_TRIGGERS.length) invalid("escalationRules must be an array");
    const seen = new Set<string>();
    patch.escalationRules = value.escalationRules.map((item, index): FacilityEscalationRule => {
      const rule = record(item, `escalationRules[${index}]`);
      exactKeys(rule, ["trigger", "enabled", "notifyRoles"], `escalationRules[${index}]`);
      const trigger = oneOf<EscalationTrigger>(rule.trigger, ESCALATION_TRIGGERS, "trigger");
      if (seen.has(trigger)) invalid("escalationRules has duplicate trigger");
      seen.add(trigger);
      if (!Array.isArray(rule.notifyRoles) || rule.notifyRoles.length === 0 || rule.notifyRoles.length > STAFF_ROLES.length) invalid("notifyRoles must be a non-empty array");
      return {
        trigger,
        enabled: bool(rule.enabled, "enabled"),
        notifyRoles: [...new Set(rule.notifyRoles.map((role) => oneOf<StaffRole>(role, STAFF_ROLES, "notifyRoles")))],
      };
    });
  }
  if (value.autoCreateCaseFor !== undefined) {
    if (!Array.isArray(value.autoCreateCaseFor) || value.autoCreateCaseFor.length > SIGNAL_TYPES.length) invalid("autoCreateCaseFor must be an array");
    patch.autoCreateCaseFor = value.autoCreateCaseFor.map((item) => oneOf<SignalType>(item, SIGNAL_TYPES, "autoCreateCaseFor"));
  }
  if (value.linkDuplicateSignals !== undefined) patch.linkDuplicateSignals = bool(value.linkDuplicateSignals, "linkDuplicateSignals");
  if (value.categories !== undefined) {
    if (!Array.isArray(value.categories) || value.categories.length > 50) invalid("categories must be an array of at most 50");
    patch.categories = value.categories.map((item) => text(item, "category", 64));
  }
  return { expectedVersion: positiveInt(value.expectedVersion, "expectedVersion"), patch };
}
