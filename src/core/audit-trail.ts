import { applyEvent } from "./case-core.ts";
import type {
  CaseAggregate,
  CaseEvent,
} from "./types.ts";

/**
 * Fields whose before/after values are tracked for every transition.
 * Free text (notes, summaries) stays in the event payload; the audit
 * view references it by sequence instead of duplicating it.
 */
export const AUDITED_CASE_FIELDS = [
  "status",
  "priority",
  "priorityRationale",
  "category",
  "assigneeId",
  "handoffTargetId",
  "escalation",
  "facilityId",
  "reopenedCount",
  "linkedSignalCount",
] as const;

export type AuditedCaseField = (typeof AUDITED_CASE_FIELDS)[number];

export interface CaseAuditChange {
  field: AuditedCaseField;
  before: unknown;
  after: unknown;
}

export interface CaseAuditEntry {
  tenantId: string;
  caseId: string;
  sequence: number;
  at: string;
  /** null only for adapter-originated system events. */
  actorId: string | null;
  action: CaseEvent["type"];
  versionBefore: number;
  versionAfter: number;
  changes: CaseAuditChange[];
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Derives an audit trail (who / when / what changed, before and after)
 * by replaying the append-only event stream. Because it is a pure
 * projection of immutable events it cannot drift from the Case history.
 */
export function projectCaseAuditTrail(
  events: readonly CaseEvent[],
): CaseAuditEntry[] {
  const entries: CaseAuditEntry[] = [];
  let current: CaseAggregate | null = null;

  for (const event of events) {
    const before: CaseAggregate | null = current;
    const after: CaseAggregate = applyEvent(current, event);
    const changes: CaseAuditChange[] = [];

    for (const field of AUDITED_CASE_FIELDS) {
      const previous = before ? before[field] : null;
      const nextValue = after[field];
      if (!before || !sameValue(previous, nextValue)) {
        if (!before && (nextValue === null || nextValue === 0)) {
          continue;
        }
        changes.push({
          field,
          before: before ? structuredClone(previous) : null,
          after: structuredClone(nextValue),
        });
      }
    }

    entries.push({
      tenantId: after.tenantId,
      caseId: after.id,
      sequence: event.sequence,
      at: event.at,
      actorId: event.actorId ?? null,
      action: event.type,
      versionBefore: before ? before.version : 0,
      versionAfter: after.version,
      changes,
    });

    current = after;
  }

  return entries;
}
