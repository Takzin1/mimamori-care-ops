import type { StaffRole } from "../access/types.ts";
import type {
  CasePriority,
  SignalType,
} from "../core/types.ts";
import type {
  CaseSlaPolicy,
  SlaStage,
} from "../operations/sla.ts";

/* ------------------------------------------------------------------ */
/* Signals (受信した通知) — kept separate from Cases so that notification
 * volume and Case volume are never conflated.                          */
/* ------------------------------------------------------------------ */

export const SIGNAL_DISPOSITIONS = [
  "pending",
  "case_created",
  "linked",
  "dismissed",
] as const;

export type SignalDisposition = (typeof SIGNAL_DISPOSITIONS)[number];

export interface SignalRecord {
  /** Internal record id. */
  id: string;
  tenantId: string;
  facilityId: string | null;
  sourceAdapter: string;
  sourceSignalId: string;
  sourceType: SignalType;
  /** Internal resident reference. Never a name. */
  subjectId: string;
  receivedAt: string;
  /** 原文 as received (bounded). Treated as care data. */
  rawText: string | null;
  priorityHint: CasePriority | null;
  disposition: SignalDisposition;
  caseId: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  dismissReason: string | null;
  /** Identical re-deliveries of the same upstream signal id. */
  replayCount: number;
  /** Staff actor who entered the signal manually (null for adapters). */
  receivedBy: string | null;
}

export interface SignalListFilter {
  disposition?: SignalDisposition;
  caseId?: string;
  /** Canonical ISO instants; receivedAt in [receivedFrom, receivedTo). */
  receivedFrom?: string;
  receivedTo?: string;
}

export interface SignalStore {
  findBySource(
    tenantId: string,
    sourceAdapter: string,
    sourceSignalId: string,
  ): Promise<SignalRecord | null>;
  get(tenantId: string, id: string): Promise<SignalRecord | null>;
  /** Idempotent on (tenantId, sourceAdapter, sourceSignalId). */
  insert(record: SignalRecord): Promise<{ record: SignalRecord; created: boolean }>;
  /** Compare-and-set on the current disposition. */
  updateDisposition(
    record: SignalRecord,
    expected: SignalDisposition,
  ): Promise<boolean>;
  incrementReplay(tenantId: string, id: string): Promise<void>;
  list(tenantId: string, filter?: SignalListFilter): Promise<SignalRecord[]>;
}

/* ------------------------------------------------------------------ */
/* Facility settings                                                    */
/* ------------------------------------------------------------------ */

export type EscalationTrigger =
  | SlaStage
  | "critical_unacknowledged"
  /** Assignee or handoff target can no longer act (deactivated / moved). */
  | "assignee_unavailable";

export const ESCALATION_TRIGGERS: readonly EscalationTrigger[] = [
  "critical_unacknowledged",
  "acknowledge",
  "assign",
  "first_action",
  "handoff_accept",
  "complete",
  "assignee_unavailable",
];

export const MAX_ESCALATION_REPEATS = 10;

export interface FacilityEscalationRule {
  trigger: EscalationTrigger;
  enabled: boolean;
  notifyRoles: StaffRole[];
  /**
   * Re-notify while the condition persists and nobody has acted.
   * Omitted / 0 = notify once.
   */
  repeatEveryMinutes?: number;
  /** Upper bound of re-notifications (default 3, max MAX_ESCALATION_REPEATS). */
  maxRepeats?: number;
}

export interface SlaApproval {
  /**
   * Thresholds are internal operating targets, not clinical standards.
   * "unapproved" means the facility has not signed off yet; the UI keeps
   * showing a provisional banner until a supervisor approves.
   */
  status: "unapproved" | "approved";
  approvedBy: string | null;
  approvedAt: string | null;
  note: string | null;
}

export interface FacilitySettings {
  tenantId: string;
  facilityId: string;
  displayName: string;
  sla: CaseSlaPolicy;
  slaApproval: SlaApproval;
  escalationRules: FacilityEscalationRule[];
  /** Signal types that open a Case automatically on intake. */
  autoCreateCaseFor: SignalType[];
  /** Link new signals for a subject that already has an open Case. */
  linkDuplicateSignals: boolean;
  categories: string[];
  version: number;
  updatedAt: string;
  updatedBy: string | null;
}

export interface FacilitySettingsStore {
  get(tenantId: string, facilityId: string): Promise<FacilitySettings | null>;
  list(tenantId: string): Promise<FacilitySettings[]>;
  /** Compare-and-set on version. expectedVersion 0 = create. */
  save(settings: FacilitySettings, expectedVersion: number): Promise<boolean>;
}

/* ------------------------------------------------------------------ */
/* Platform audit log (non-Case-event decisions)                        */
/* ------------------------------------------------------------------ */

export type AuditTargetType =
  | "signal"
  | "settings"
  | "ai_draft"
  | "notification"
  | "case";

export interface PlatformAuditEntry {
  id: string;
  tenantId: string;
  facilityId: string | null;
  at: string;
  actorId: string | null;
  action: string;
  targetType: AuditTargetType;
  targetId: string;
  before: unknown;
  after: unknown;
  reason: string | null;
}

export interface AuditLogStore {
  append(entry: PlatformAuditEntry): Promise<void>;
  list(tenantId: string, options?: { targetId?: string; limit?: number }): Promise<PlatformAuditEntry[]>;
}

/* ------------------------------------------------------------------ */
/* AI drafts                                                             */
/* ------------------------------------------------------------------ */

export const AI_DRAFT_KINDS = [
  "case_summary",
  "handoff",
  "fact_extraction",
] as const;

export type AiDraftKind = (typeof AI_DRAFT_KINDS)[number];

export type AiDraftStatus =
  | "pending_review"
  | "approved"
  | "rejected"
  | "failed";

export interface AiDraftFact {
  label: string;
  value: string;
  /** Exact excerpt of the source text supporting this fact. */
  quote: string;
  sourceRef: string;
  /** true only when `quote` is literally present in the source. */
  verified: boolean;
}

export interface AiDraftContent {
  text: string;
  facts: AiDraftFact[];
  missing: string[];
  uncertain: string[];
  warnings: string[];
}

export interface AiDraftSourceRef {
  ref: string;
  label: string;
}

export interface AiDraft {
  id: string;
  tenantId: string;
  facilityId: string | null;
  caseId: string;
  kind: AiDraftKind;
  status: AiDraftStatus;
  provider: string;
  model: string;
  generatedAt: string;
  requestedBy: string;
  caseVersionAtGeneration: number;
  sources: AiDraftSourceRef[];
  content: AiDraftContent | null;
  error: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  appliedEventSequence: number | null;
}

export interface AiDraftStore {
  insert(draft: AiDraft): Promise<void>;
  get(tenantId: string, id: string): Promise<AiDraft | null>;
  /** Compare-and-set on status. */
  update(draft: AiDraft, expectedStatus: AiDraftStatus): Promise<boolean>;
  listByCase(tenantId: string, caseId: string): Promise<AiDraft[]>;
}

/* ------------------------------------------------------------------ */
/* Staff notifications (in-app inbox fed by the outbox worker)          */
/* ------------------------------------------------------------------ */

export interface StaffNotification {
  id: string;
  tenantId: string;
  facilityId: string | null;
  deliveryKey: string;
  recipientRoles: StaffRole[];
  kind: "sla_breach" | "critical_unacknowledged" | "manual_escalation" | "assignee_unavailable";
  caseId: string;
  /** Non-PII operational message (no resident identifiers). */
  message: string;
  createdAt: string;
}

export interface StaffNotificationInbox {
  /** Idempotent on (tenantId, deliveryKey). */
  deliver(notification: StaffNotification): Promise<boolean>;
  list(tenantId: string, limit?: number): Promise<StaffNotification[]>;
}

export interface StaffNotificationChannel {
  readonly name: string;
  deliver(notification: StaffNotification): Promise<void>;
}

export const STAFF_NOTIFICATION_TOPIC = "careops.staff_notification";

export interface StaffNotificationPayload {
  kind: StaffNotification["kind"];
  caseId: string;
  facilityId: string | null;
  recipientRoles: StaffRole[];
  message: string;
  stage?: EscalationTrigger;
  priority?: CasePriority;
}
