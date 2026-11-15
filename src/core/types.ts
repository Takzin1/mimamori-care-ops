export const CASE_STATUSES = [
  "NEW",
  "ACKNOWLEDGED",
  "TRIAGED",
  "ASSIGNED",
  "IN_PROGRESS",
  "HANDOFF_PENDING",
  "COMPLETED",
  "CLOSED",
] as const;

export type CaseStatus = (typeof CASE_STATUSES)[number];

export const CASE_PRIORITIES = [
  "critical",
  "high",
  "normal",
  "low",
] as const;

export type CasePriority = (typeof CASE_PRIORITIES)[number];

export const SIGNAL_TYPES = [
  "non_response",
  "unwell",
  "sos",
  "snow_report",
  "free_text",
  "crisis_no_response",
  "welfare_need_help",
  "manual",
  "external_api",
] as const;

export type SignalType = (typeof SIGNAL_TYPES)[number];

export const COMPLETION_OUTCOMES = [
  "confirmed_safe",
  "family_confirmed",
  "visit_completed",
  "support_connected",
  "supplies_delivered",
  "emergency_handoff_completed",
  "false_alarm",
  "declined",
  "other",
] as const;

export type CompletionOutcome = (typeof COMPLETION_OUTCOMES)[number];

export const EVIDENCE_KINDS = [
  "note",
  "call",
  "visit",
  "message",
  "external_ref",
] as const;

export type EvidenceKind =
  (typeof EVIDENCE_KINDS)[number];

/**
 * Operational note kinds for the Case action history.
 * - observation: staff confirmed the resident's state (updates lastCheckedAt)
 * - action: staff performed a support action
 * - contact: staff contacted family / external party
 * - other: anything else worth recording
 */
export const CASE_NOTE_KINDS = [
  "observation",
  "action",
  "contact",
  "other",
] as const;

export type CaseNoteKind = (typeof CASE_NOTE_KINDS)[number];

/**
 * Provenance of a note. Human-authored notes have no origin.
 * AI-derived notes are only appended after an explicit human approval
 * and keep a pointer to the reviewed draft.
 */
export interface CaseNoteOrigin {
  type: "ai_draft";
  draftId: string;
  provider: string;
  model: string;
  generatedAt: string;
}

export interface CaseEscalation {
  reason: string;
  escalatedAt: string;
  escalatedBy: string;
}

export interface CompletionEvidenceItem {
  kind: EvidenceKind;
  ref: string;
}

export interface CompletionRecord {
  outcome: CompletionOutcome;
  summary: string;
  evidence: CompletionEvidenceItem[];
  completedBy: string;
  completedAt: string;
}

export interface CaseAggregate {
  id: string;
  tenantId: string;
  subjectId: string;
  sourceType: SignalType;
  sourceAdapter: string;
  sourceSignalId: string;
  priority: CasePriority;
  status: CaseStatus;
  version: number;
  assigneeId: string | null;
  handoffTargetId: string | null;
  createdAt: string;
  acknowledgedAt: string | null;
  assignedAt: string | null;
  firstActionAt: string | null;
  completedAt: string | null;
  closedAt: string | null;
  reopenedCount: number;
  completion: CompletionRecord | null;
  /** Facility (site) inside the tenant. null = tenant-level Case. */
  facilityId: string | null;
  /** Event / cause category set at intake or triage. */
  category: string | null;
  /** Human-provided justification for the current priority. */
  priorityRationale: string | null;
  triagedAt: string | null;
  /** Staff actor who created the Case manually; null for adapter intake. */
  createdBy: string | null;
  escalation: CaseEscalation | null;
  /** 申し送り attached to the pending handoff request. */
  handoffNote: string | null;
  handoffRequestedAt: string | null;
  /** Last time staff recorded a confirmation of the resident's state. */
  lastCheckedAt: string | null;
  /** Time of the most recent event on the Case. */
  lastActivityAt: string;
  /** Additional signals linked to this open Case (duplicates). */
  linkedSignalCount: number;
}

interface EventBase {
  sequence: number;
  at: string;
  actorId: string | null;
}

export type CaseEvent =
  | (EventBase & {
      type: "case_created";
      data: {
        caseId: string;
        tenantId: string;
        subjectId: string;
        sourceType: SignalType;
        sourceAdapter: string;
        sourceSignalId: string;
        priority: CasePriority;
        facilityId?: string;
        category?: string;
        priorityRationale?: string;
      };
    })
  | (EventBase & {
      type: "priority_changed";
      actorId: string;
      data: {
        previousPriority: CasePriority;
        priority: CasePriority;
        rationale?: string;
      };
    })
  | (EventBase & {
      type: "triaged";
      actorId: string;
      data: {
        category: string;
        previousPriority: CasePriority;
        priority: CasePriority;
        rationale: string;
      };
    })
  | (EventBase & {
      type: "note_added";
      actorId: string;
      data: {
        kind: CaseNoteKind;
        text: string;
        origin?: CaseNoteOrigin;
        /** References backing this entry (call log, visit record…). */
        evidence?: CompletionEvidenceItem[];
      };
    })
  | (EventBase & {
      type: "escalated";
      actorId: string;
      data: { reason: string };
    })
  | (EventBase & {
      type: "escalation_cleared";
      actorId: string;
      data: { reason: string };
    })
  | (EventBase & {
      type: "reassigned";
      actorId: string;
      data: {
        previousAssigneeId: string | null;
        assigneeId: string;
        reason: string;
        cancelledHandoffTargetId?: string;
      };
    })
  | (EventBase & {
      type: "handoff_declined";
      actorId: string;
      data: { targetAssigneeId: string; reason: string };
    })
  | (EventBase & {
      type: "handoff_cancelled";
      actorId: string;
      data: { targetAssigneeId: string; reason: string };
    })
  | (EventBase & {
      type: "signal_linked";
      data: {
        sourceAdapter: string;
        sourceSignalId: string;
        sourceType: SignalType;
      };
    })
  | (EventBase & {
      type: "acknowledged";
      actorId: string;
      data: Record<string, never>;
    })
  | (EventBase & {
      type: "assigned";
      actorId: string;
      data: { assigneeId: string };
    })
  | (EventBase & {
      type: "action_started";
      actorId: string;
      data: Record<string, never>;
    })
  | (EventBase & {
      type: "handoff_requested";
      actorId: string;
      data: { targetAssigneeId: string; note?: string };
    })
  | (EventBase & {
      type: "handoff_accepted";
      actorId: string;
      data: { previousAssigneeId: string };
    })
  | (EventBase & {
      type: "completed";
      actorId: string;
      data: {
        outcome: CompletionOutcome;
        summary: string;
        evidence: CompletionEvidenceItem[];
      };
    })
  | (EventBase & {
      type: "closed";
      actorId: string;
      data: Record<string, never>;
    })
  | (EventBase & {
      type: "reopened";
      actorId: string;
      data: { reason: string };
    });

export type CaseCreatedEvent = Extract<CaseEvent, { type: "case_created" }>;

export const CASE_COMMAND_TYPES = [
  "set_priority",
  "acknowledge",
  "triage",
  "assign",
  "reassign",
  "start_action",
  "add_note",
  "escalate",
  "clear_escalation",
  "request_handoff",
  "accept_handoff",
  "decline_handoff",
  "cancel_handoff",
  "complete",
  "close",
  "reopen",
] as const;

export type CaseCommandType =
  (typeof CASE_COMMAND_TYPES)[number];

export type CaseCommand =
  | {
      type: "set_priority";
      actorId: string;
      priority: CasePriority;
      rationale?: string;
    }
  | { type: "acknowledge"; actorId: string }
  | {
      type: "triage";
      actorId: string;
      category: string;
      priority: CasePriority;
      rationale: string;
    }
  | { type: "assign"; actorId: string; assigneeId: string }
  | {
      type: "reassign";
      actorId: string;
      assigneeId: string;
      reason: string;
    }
  | { type: "start_action"; actorId: string }
  | {
      type: "add_note";
      actorId: string;
      kind: CaseNoteKind;
      text: string;
      origin?: CaseNoteOrigin;
      evidence?: CompletionEvidenceItem[];
    }
  | { type: "escalate"; actorId: string; reason: string }
  | { type: "clear_escalation"; actorId: string; reason: string }
  | {
      type: "request_handoff";
      actorId: string;
      targetAssigneeId: string;
      note?: string;
    }
  | { type: "accept_handoff"; actorId: string }
  | { type: "decline_handoff"; actorId: string; reason: string }
  | { type: "cancel_handoff"; actorId: string; reason: string }
  | {
      type: "complete";
      actorId: string;
      outcome: CompletionOutcome;
      summary: string;
      evidence: CompletionEvidenceItem[];
    }
  | { type: "close"; actorId: string }
  | { type: "reopen"; actorId: string; reason: string };

export interface NewCaseInput {
  id: string;
  tenantId: string;
  subjectId: string;
  sourceType: SignalType;
  sourceAdapter: string;
  sourceSignalId: string;
  priority: CasePriority;
  createdAt: string;
  facilityId?: string;
  category?: string;
  priorityRationale?: string;
  /** Staff actor creating the Case manually. Omit for adapter intake. */
  createdBy?: string;
}

export interface LinkSignalInput {
  sourceAdapter: string;
  sourceSignalId: string;
  sourceType: SignalType;
  /** Staff actor who linked the signal; null for automatic intake. */
  linkedBy: string | null;
}
