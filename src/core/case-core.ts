import {
  CASE_NOTE_KINDS,
  type CaseAggregate,
  type CaseCommand,
  type CaseCommandType,
  type CaseCreatedEvent,
  type CaseEvent,
  type CaseStatus,
  type LinkSignalInput,
  type NewCaseInput,
} from "./types.ts";
import {
  CaseConflictError,
  InvalidTransitionError,
} from "./errors.ts";

/**
 * Statuses in which the Case still requires accountable human work.
 * COMPLETED is presented as "RESOLVED" in the CareOps UI.
 */
export const OPEN_CASE_STATUSES: readonly CaseStatus[] = [
  "NEW",
  "ACKNOWLEDGED",
  "TRIAGED",
  "ASSIGNED",
  "IN_PROGRESS",
  "HANDOFF_PENDING",
];

export function isOpenCaseStatus(status: CaseStatus): boolean {
  return OPEN_CASE_STATUSES.includes(status);
}

function requireText(value: string, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw new InvalidTransitionError(`${label} is required`);
  }
  return normalized;
}

function optionalText(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function requireStatus(
  aggregate: CaseAggregate,
  ...allowed: CaseAggregate["status"][]
): void {
  if (!allowed.includes(aggregate.status)) {
    throw new InvalidTransitionError(
      `Cannot transition from ${aggregate.status}; expected ${allowed.join(" or ")}`,
    );
  }
}

function requireOpen(aggregate: CaseAggregate): void {
  requireStatus(aggregate, ...OPEN_CASE_STATUSES);
}

function requireCurrentAssignee(
  aggregate: CaseAggregate,
  actorId: string,
): void {
  if (!aggregate.assigneeId || aggregate.assigneeId !== actorId) {
    throw new InvalidTransitionError(
      "Only the current assignee may perform this transition",
    );
  }
}

function requireHandoffTarget(
  aggregate: CaseAggregate,
  actorId: string,
): void {
  if (
    !aggregate.handoffTargetId ||
    aggregate.handoffTargetId !== actorId
  ) {
    throw new InvalidTransitionError(
      "Only the requested handoff target may perform this transition",
    );
  }
}

export function assertCaseCommandAvailable(
  aggregate: CaseAggregate,
  actorId: string,
  type: CaseCommandType,
): void {
  const actor = requireText(actorId, "actor id");

  switch (type) {
    case "set_priority":
      requireOpen(aggregate);
      return;

    case "acknowledge":
      requireStatus(aggregate, "NEW");
      return;

    case "triage":
      requireStatus(aggregate, "ACKNOWLEDGED", "TRIAGED");
      return;

    case "assign":
      requireStatus(aggregate, "ACKNOWLEDGED", "TRIAGED");
      return;

    case "reassign":
      requireStatus(
        aggregate,
        "ASSIGNED",
        "IN_PROGRESS",
        "HANDOFF_PENDING",
      );
      if (!aggregate.assigneeId) {
        throw new InvalidTransitionError(
          "Reassignment requires a current assignee",
        );
      }
      return;

    case "start_action":
      requireStatus(aggregate, "ASSIGNED");
      requireCurrentAssignee(aggregate, actor);
      return;

    case "add_note":
      if (aggregate.status === "CLOSED") {
        throw new InvalidTransitionError(
          "Closed Cases must be reopened before adding history",
        );
      }
      return;

    case "escalate":
      requireOpen(aggregate);
      if (aggregate.escalation) {
        throw new InvalidTransitionError(
          "Case is already escalated",
        );
      }
      return;

    case "clear_escalation":
      if (!aggregate.escalation) {
        throw new InvalidTransitionError(
          "Case is not escalated",
        );
      }
      return;

    case "request_handoff":
      requireStatus(aggregate, "IN_PROGRESS");
      requireCurrentAssignee(aggregate, actor);
      return;

    case "accept_handoff":
      requireStatus(aggregate, "HANDOFF_PENDING");
      requireHandoffTarget(aggregate, actor);
      if (!aggregate.assigneeId) {
        throw new InvalidTransitionError(
          "Handoff cannot proceed without an outgoing assignee",
        );
      }
      return;

    case "decline_handoff":
      requireStatus(aggregate, "HANDOFF_PENDING");
      requireHandoffTarget(aggregate, actor);
      return;

    case "cancel_handoff":
      requireStatus(aggregate, "HANDOFF_PENDING");
      requireCurrentAssignee(aggregate, actor);
      return;

    case "complete":
      requireStatus(aggregate, "IN_PROGRESS");
      requireCurrentAssignee(aggregate, actor);
      return;

    case "close":
      requireStatus(aggregate, "COMPLETED");
      return;

    case "reopen":
      requireStatus(
        aggregate,
        "COMPLETED",
        "CLOSED",
      );
      return;
  }
}

export function canCaseCommand(
  aggregate: CaseAggregate,
  actorId: string,
  type: CaseCommandType,
): boolean {
  try {
    assertCaseCommandAvailable(
      aggregate,
      actorId,
      type,
    );
    return true;
  } catch (error) {
    if (error instanceof InvalidTransitionError) {
      return false;
    }
    throw error;
  }
}

export function createCase(input: NewCaseInput): {
  aggregate: CaseAggregate;
  event: CaseCreatedEvent;
} {
  const caseId = requireText(input.id, "case id");
  const tenantId = requireText(input.tenantId, "tenant id");
  const subjectId = requireText(input.subjectId, "subject id");
  const sourceAdapter = requireText(input.sourceAdapter, "source adapter");
  const sourceSignalId = requireText(input.sourceSignalId, "source signal id");
  const facilityId = optionalText(input.facilityId);
  const category = optionalText(input.category);
  const priorityRationale = optionalText(input.priorityRationale);
  const createdBy = optionalText(input.createdBy);

  // Optional keys are only present when provided so that legacy
  // case_created payloads stay byte-for-byte identical.
  const event: CaseCreatedEvent = {
    type: "case_created",
    sequence: 1,
    at: input.createdAt,
    actorId: createdBy ?? null,
    data: {
      caseId,
      tenantId,
      subjectId,
      sourceType: input.sourceType,
      sourceAdapter,
      sourceSignalId,
      priority: input.priority,
      ...(facilityId ? { facilityId } : {}),
      ...(category ? { category } : {}),
      ...(priorityRationale ? { priorityRationale } : {}),
    },
  };

  return { aggregate: applyEvent(null, event), event };
}

/**
 * Records that an additional upstream signal refers to an open Case
 * (duplicate notification). The Case is not re-created and no status
 * changes; the linkage is visible in the timeline and audit trail.
 */
export function linkSignalToCase(
  aggregate: CaseAggregate,
  expectedVersion: number,
  input: LinkSignalInput,
  at: string,
): { aggregate: CaseAggregate; event: CaseEvent } {
  if (aggregate.version !== expectedVersion) {
    throw new CaseConflictError(expectedVersion, aggregate.version);
  }
  requireOpen(aggregate);

  const event: CaseEvent = {
    type: "signal_linked",
    sequence: aggregate.version + 1,
    at,
    actorId: input.linkedBy ? requireText(input.linkedBy, "actor id") : null,
    data: {
      sourceAdapter: requireText(input.sourceAdapter, "source adapter"),
      sourceSignalId: requireText(input.sourceSignalId, "source signal id"),
      sourceType: input.sourceType,
    },
  };

  return { aggregate: applyEvent(aggregate, event), event };
}

export function executeCommand(
  aggregate: CaseAggregate,
  expectedVersion: number,
  command: CaseCommand,
  at: string,
): { aggregate: CaseAggregate; event: CaseEvent } {
  if (aggregate.version !== expectedVersion) {
    throw new CaseConflictError(expectedVersion, aggregate.version);
  }

  const actorId = requireText(command.actorId, "actor id");
  assertCaseCommandAvailable(
    aggregate,
    actorId,
    command.type,
  );
  const sequence = aggregate.version + 1;
  let event: CaseEvent;

  switch (command.type) {
    case "set_priority": {
      if (command.priority === aggregate.priority) {
        throw new InvalidTransitionError(
          "Priority change must select a different priority",
        );
      }
      const rationale = optionalText(command.rationale);
      event = {
        type: "priority_changed",
        sequence,
        at,
        actorId,
        data: {
          previousPriority: aggregate.priority,
          priority: command.priority,
          ...(rationale ? { rationale } : {}),
        },
      };
      break;
    }

    case "acknowledge":
      event = {
        type: "acknowledged",
        sequence,
        at,
        actorId,
        data: {},
      };
      break;

    case "triage":
      event = {
        type: "triaged",
        sequence,
        at,
        actorId,
        data: {
          category: requireText(command.category, "triage category"),
          previousPriority: aggregate.priority,
          priority: command.priority,
          rationale: requireText(command.rationale, "priority rationale"),
        },
      };
      break;

    case "assign":
      event = {
        type: "assigned",
        sequence,
        at,
        actorId,
        data: { assigneeId: requireText(command.assigneeId, "assignee id") },
      };
      break;

    case "reassign": {
      const assigneeId = requireText(command.assigneeId, "assignee id");
      if (assigneeId === aggregate.assigneeId) {
        throw new InvalidTransitionError(
          "Reassignment must select a different assignee",
        );
      }
      event = {
        type: "reassigned",
        sequence,
        at,
        actorId,
        data: {
          previousAssigneeId: aggregate.assigneeId,
          assigneeId,
          reason: requireText(command.reason, "reassignment reason"),
          ...(aggregate.handoffTargetId
            ? { cancelledHandoffTargetId: aggregate.handoffTargetId }
            : {}),
        },
      };
      break;
    }

    case "start_action":
      event = {
        type: "action_started",
        sequence,
        at,
        actorId,
        data: {},
      };
      break;

    case "add_note": {
      if (!CASE_NOTE_KINDS.includes(command.kind)) {
        throw new InvalidTransitionError("note kind is not supported");
      }
      event = {
        type: "note_added",
        sequence,
        at,
        actorId,
        data: {
          kind: command.kind,
          text: requireText(command.text, "note text"),
          ...(command.origin ? { origin: { ...command.origin } } : {}),
        },
      };
      break;
    }

    case "escalate":
      event = {
        type: "escalated",
        sequence,
        at,
        actorId,
        data: { reason: requireText(command.reason, "escalation reason") },
      };
      break;

    case "clear_escalation":
      event = {
        type: "escalation_cleared",
        sequence,
        at,
        actorId,
        data: { reason: requireText(command.reason, "clearance reason") },
      };
      break;

    case "request_handoff": {
      if (requireText(command.targetAssigneeId, "handoff target") === actorId) {
        throw new InvalidTransitionError(
          "Handoff target must differ from current assignee",
        );
      }
      const note = optionalText(command.note);
      event = {
        type: "handoff_requested",
        sequence,
        at,
        actorId,
        data: {
          targetAssigneeId: command.targetAssigneeId.trim(),
          ...(note ? { note } : {}),
        },
      };
      break;
    }

    case "accept_handoff":
      event = {
        type: "handoff_accepted",
        sequence,
        at,
        actorId,
        data: {
          previousAssigneeId:
            aggregate.assigneeId!,
        },
      };
      break;

    case "decline_handoff":
      event = {
        type: "handoff_declined",
        sequence,
        at,
        actorId,
        data: {
          targetAssigneeId: aggregate.handoffTargetId!,
          reason: requireText(command.reason, "decline reason"),
        },
      };
      break;

    case "cancel_handoff":
      event = {
        type: "handoff_cancelled",
        sequence,
        at,
        actorId,
        data: {
          targetAssigneeId: aggregate.handoffTargetId!,
          reason: requireText(command.reason, "cancel reason"),
        },
      };
      break;

    case "complete":
      if (command.evidence.length === 0) {
        throw new InvalidTransitionError(
          "Completion requires at least one evidence item",
        );
      }
      event = {
        type: "completed",
        sequence,
        at,
        actorId,
        data: {
          outcome: command.outcome,
          summary: requireText(command.summary, "completion summary"),
          evidence: command.evidence.map((item) => ({
            kind: item.kind,
            ref: requireText(item.ref, "evidence ref"),
          })),
        },
      };
      break;

    case "close":
      event = {
        type: "closed",
        sequence,
        at,
        actorId,
        data: {},
      };
      break;

    case "reopen":
      event = {
        type: "reopened",
        sequence,
        at,
        actorId,
        data: { reason: requireText(command.reason, "reopen reason") },
      };
      break;
  }

  return { aggregate: applyEvent(aggregate, event), event };
}

function requireActor(
  event: CaseEvent,
): string {
  if (!event.actorId) {
    throw new InvalidTransitionError(
      `${event.type} requires an accountable actor`,
    );
  }
  return event.actorId;
}

export function applyEvent(
  aggregate: CaseAggregate | null,
  event: CaseEvent,
): CaseAggregate {
  if (event.type === "case_created") {
    if (aggregate) {
      throw new InvalidTransitionError(
        "case_created must be the first event",
      );
    }
    if (event.sequence !== 1) {
      throw new InvalidTransitionError(
        "case_created must have sequence 1",
      );
    }

    return {
      id: event.data.caseId,
      tenantId: event.data.tenantId,
      subjectId: event.data.subjectId,
      sourceType: event.data.sourceType,
      sourceAdapter: event.data.sourceAdapter,
      sourceSignalId: event.data.sourceSignalId,
      priority: event.data.priority,
      status: "NEW",
      version: 1,
      assigneeId: null,
      handoffTargetId: null,
      createdAt: event.at,
      acknowledgedAt: null,
      assignedAt: null,
      firstActionAt: null,
      completedAt: null,
      closedAt: null,
      reopenedCount: 0,
      completion: null,
      facilityId: event.data.facilityId ?? null,
      category: event.data.category ?? null,
      priorityRationale: event.data.priorityRationale ?? null,
      triagedAt: null,
      createdBy: event.actorId ?? null,
      escalation: null,
      handoffNote: null,
      handoffRequestedAt: null,
      lastCheckedAt: null,
      lastActivityAt: event.at,
      linkedSignalCount: 0,
    };
  }

  if (!aggregate) {
    throw new InvalidTransitionError(
      "case_created must precede all other events",
    );
  }
  if (event.sequence !== aggregate.version + 1) {
    throw new InvalidTransitionError(
      `Event sequence gap: expected ${aggregate.version + 1}, received ${event.sequence}`,
    );
  }

  const next: CaseAggregate = {
    ...aggregate,
    version: event.sequence,
    lastActivityAt: event.at,
  };

  switch (event.type) {
    case "priority_changed":
      requireOpen(aggregate);
      if (event.data.previousPriority !== aggregate.priority) {
        throw new InvalidTransitionError(
          "Priority change previous value does not match aggregate",
        );
      }
      if (event.data.priority === aggregate.priority) {
        throw new InvalidTransitionError(
          "Priority change must select a different priority",
        );
      }
      return {
        ...next,
        priority: event.data.priority,
        priorityRationale: event.data.rationale ?? null,
      };

    case "acknowledged":
      requireStatus(aggregate, "NEW");
      return {
        ...next,
        status: "ACKNOWLEDGED",
        acknowledgedAt: event.at,
      };

    case "triaged":
      requireStatus(aggregate, "ACKNOWLEDGED", "TRIAGED");
      requireActor(event);
      if (event.data.previousPriority !== aggregate.priority) {
        throw new InvalidTransitionError(
          "Triage previous priority does not match aggregate",
        );
      }
      return {
        ...next,
        status: "TRIAGED",
        category: event.data.category,
        priority: event.data.priority,
        priorityRationale: event.data.rationale,
        triagedAt: event.at,
      };

    case "assigned":
      requireStatus(aggregate, "ACKNOWLEDGED", "TRIAGED");
      return {
        ...next,
        status: "ASSIGNED",
        assigneeId: event.data.assigneeId,
        assignedAt: event.at,
      };

    case "reassigned": {
      requireStatus(
        aggregate,
        "ASSIGNED",
        "IN_PROGRESS",
        "HANDOFF_PENDING",
      );
      requireActor(event);
      if (event.data.previousAssigneeId !== aggregate.assigneeId) {
        throw new InvalidTransitionError(
          "Reassignment previous assignee does not match aggregate",
        );
      }
      return {
        ...next,
        status:
          aggregate.status === "HANDOFF_PENDING"
            ? "IN_PROGRESS"
            : aggregate.status,
        assigneeId: event.data.assigneeId,
        handoffTargetId: null,
        handoffNote: null,
        handoffRequestedAt: null,
      };
    }

    case "action_started":
      requireStatus(aggregate, "ASSIGNED");
      requireCurrentAssignee(aggregate, event.actorId);
      return {
        ...next,
        status: "IN_PROGRESS",
        firstActionAt: aggregate.firstActionAt ?? event.at,
      };

    case "note_added":
      if (aggregate.status === "CLOSED") {
        throw new InvalidTransitionError(
          "Closed Cases must be reopened before adding history",
        );
      }
      requireActor(event);
      return {
        ...next,
        lastCheckedAt:
          event.data.kind === "observation"
            ? event.at
            : aggregate.lastCheckedAt,
      };

    case "escalated":
      requireOpen(aggregate);
      if (aggregate.escalation) {
        throw new InvalidTransitionError("Case is already escalated");
      }
      return {
        ...next,
        escalation: {
          reason: event.data.reason,
          escalatedAt: event.at,
          escalatedBy: requireActor(event),
        },
      };

    case "escalation_cleared":
      if (!aggregate.escalation) {
        throw new InvalidTransitionError("Case is not escalated");
      }
      requireActor(event);
      return {
        ...next,
        escalation: null,
      };

    case "handoff_requested":
      requireStatus(aggregate, "IN_PROGRESS");
      requireCurrentAssignee(aggregate, event.actorId);
      return {
        ...next,
        status: "HANDOFF_PENDING",
        handoffTargetId: event.data.targetAssigneeId,
        handoffNote: event.data.note ?? null,
        handoffRequestedAt: event.at,
      };

    case "handoff_accepted":
      requireStatus(aggregate, "HANDOFF_PENDING");
      if (aggregate.handoffTargetId !== event.actorId) {
        throw new InvalidTransitionError(
          "Handoff acceptance actor does not match target",
        );
      }
      return {
        ...next,
        status: "IN_PROGRESS",
        assigneeId: event.actorId,
        handoffTargetId: null,
        handoffNote: null,
        handoffRequestedAt: null,
      };

    case "handoff_declined":
      requireStatus(aggregate, "HANDOFF_PENDING");
      if (aggregate.handoffTargetId !== event.actorId) {
        throw new InvalidTransitionError(
          "Handoff decline actor does not match target",
        );
      }
      return {
        ...next,
        status: "IN_PROGRESS",
        handoffTargetId: null,
        handoffNote: null,
        handoffRequestedAt: null,
      };

    case "handoff_cancelled":
      requireStatus(aggregate, "HANDOFF_PENDING");
      requireCurrentAssignee(aggregate, event.actorId);
      return {
        ...next,
        status: "IN_PROGRESS",
        handoffTargetId: null,
        handoffNote: null,
        handoffRequestedAt: null,
      };

    case "signal_linked":
      requireOpen(aggregate);
      return {
        ...next,
        linkedSignalCount: aggregate.linkedSignalCount + 1,
      };

    case "completed":
      requireStatus(aggregate, "IN_PROGRESS");
      requireCurrentAssignee(aggregate, event.actorId);
      if (event.data.evidence.length === 0) {
        throw new InvalidTransitionError(
          "Completion event requires evidence",
        );
      }
      return {
        ...next,
        status: "COMPLETED",
        completedAt: event.at,
        lastCheckedAt: event.at,
        completion: {
          outcome: event.data.outcome,
          summary: event.data.summary,
          evidence: event.data.evidence,
          completedBy: event.actorId,
          completedAt: event.at,
        },
      };

    case "closed":
      requireStatus(aggregate, "COMPLETED");
      return {
        ...next,
        status: "CLOSED",
        closedAt: event.at,
      };

    case "reopened":
      requireStatus(aggregate, "COMPLETED", "CLOSED");
      return {
        ...next,
        status: "IN_PROGRESS",
        assigneeId: event.actorId,
        handoffTargetId: null,
        handoffNote: null,
        handoffRequestedAt: null,
        completedAt: null,
        closedAt: null,
        reopenedCount: aggregate.reopenedCount + 1,
        completion: null,
      };
  }
}

export function replayCase(events: readonly CaseEvent[]): CaseAggregate {
  if (events.length === 0) {
    throw new InvalidTransitionError(
      "Cannot replay a case without events",
    );
  }

  return events.reduce<CaseAggregate | null>(
    (aggregate, event) => applyEvent(aggregate, event),
    null,
  ) as CaseAggregate;
}
