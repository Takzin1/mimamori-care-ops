export const CASE_STATUSES = [
  "NEW",
  "ACKNOWLEDGED",
  "ASSIGNED",
  "IN_PROGRESS",
  "HANDOFF_PENDING",
  "COMPLETED",
  "CLOSED",
] as const;

export type CaseStatus = (typeof CASE_STATUSES)[number];

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

export type EvidenceKind =
  | "note"
  | "call"
  | "visit"
  | "message"
  | "external_ref";

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
  subjectId: string;
  sourceType: SignalType;
  sourceSignalId: string | null;
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
        subjectId: string;
        sourceType: SignalType;
        sourceSignalId: string | null;
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
      data: { targetAssigneeId: string };
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

export type CaseCommand =
  | { type: "acknowledge"; actorId: string }
  | { type: "assign"; actorId: string; assigneeId: string }
  | { type: "start_action"; actorId: string }
  | { type: "request_handoff"; actorId: string; targetAssigneeId: string }
  | { type: "accept_handoff"; actorId: string }
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
  subjectId: string;
  sourceType: SignalType;
  sourceSignalId?: string | null;
  createdAt: string;
}
