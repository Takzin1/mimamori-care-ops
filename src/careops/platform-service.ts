import { CaseAccessDeniedError } from "../access/errors.ts";
import {
  COMMAND_ROLES,
  PLATFORM_PERMISSION_ROLES,
  assertActiveMembership,
  assertFacilityInScope,
  canReadCaseAggregate,
  hasPlatformPermission,
  membershipCoversFacility,
  queueVisibilityForMembership,
  type PlatformPermission,
} from "../access/policy.ts";
import {
  STAFF_ROLES,
  type StaffRole,
  type TenantMembership,
  type TenantMembershipDirectory,
} from "../access/types.ts";
import { CaseService } from "../application/case-service.ts";
import type { CaseCapabilitiesProjection } from "../application/capabilities.ts";
import type {
  CaseCommandIntent,
  CaseOperationResult,
} from "../application/types.ts";
import {
  createCase,
  linkSignalToCase,
} from "../core/case-core.ts";
import {
  projectCaseAuditTrail,
  projectCaseEvidence,
  type CaseAuditEntry,
  type CaseEvidenceEntry,
} from "../core/audit-trail.ts";
import { CaseConflictError } from "../core/errors.ts";
import type {
  CaseAggregate,
  CaseEvent,
  CasePriority,
  SignalType,
} from "../core/types.ts";
import { OutboxWorker, type OutboxRunResult } from "../outbox/worker.ts";
import {
  evaluateCaseSla,
  validateSlaPolicy,
  type CaseSlaEvaluation,
  type CaseSlaPolicy,
} from "../operations/sla.ts";
import { CaseNotFoundError } from "../persistence/errors.ts";
import type { CaseRepository, StoredCase } from "../persistence/types.ts";
import {
  OPEN_STATUSES,
  applyCaseSearch,
  isSearchableCaseRepository,
  type CaseSearchQuery,
  type CaseSearchResult,
  type CaseSearchSort,
} from "../persistence/case-search.ts";
import {
  DisabledAiDraftProvider,
  finalizeDraftContent,
  generateWithTimeout,
  type AiDraftProvider,
  type AiSourceText,
} from "./ai-assist.ts";
import { computeCareOpsAnalytics, type CareOpsAnalytics } from "./analytics.ts";
import { PROVISIONAL_SLA_POLICY, defaultFacilitySettings, effectiveEscalationRules } from "./defaults.ts";
import {
  CareOpsConflictError,
  CareOpsNotFoundError,
  CareOpsRuleError,
} from "./errors.ts";
import type { ListableOutboxStore, OutboxListEntry } from "./in-memory-stores.ts";
import {
  projectDashboard,
  projectHandoffBoard,
  searchCases,
  toCaseListItem,
  type AvailabilityCheck,
  type CareOpsDashboard,
  type CaseListFilter,
  type CaseListPage,
  type HandoffBoard,
  type SlaPolicyResolver,
} from "./projections.ts";
import {
  MAX_ESCALATION_REPEATS,
  STAFF_NOTIFICATION_TOPIC,
  type AiDraft,
  type AiDraftKind,
  type AiDraftStore,
  type AuditLogStore,
  type FacilityEscalationRule,
  type FacilitySettings,
  type FacilitySettingsStore,
  type PlatformAuditEntry,
  type SignalDisposition,
  type SignalRecord,
  type SignalStore,
  type StaffNotification,
  type StaffNotificationChannel,
  type StaffNotificationInbox,
  type StaffNotificationPayload,
} from "./types.ts";

export interface PlatformContext {
  tenantId: string;
  principalId: string;
}

export interface CareOpsPlatformOptions {
  repository: CaseRepository;
  memberships: TenantMembershipDirectory;
  signals: SignalStore;
  settings: FacilitySettingsStore;
  audit: AuditLogStore;
  drafts: AiDraftStore;
  outbox: ListableOutboxStore;
  inbox: StaffNotificationInbox;
  /** Extra delivery channels (e.g. LINE / e-mail adapters). */
  channels?: StaffNotificationChannel[];
  ai?: AiDraftProvider;
  aiTimeoutMs?: number;
  now?: () => string;
  newId?: () => string;
  /** Used for tenant-level Cases without a facility. */
  fallbackSlaPolicy?: CaseSlaPolicy;
  notificationRetryDelayMs?: number;
}

export interface SignalIntakeInput {
  facilityId: string;
  sourceAdapter: string;
  sourceSignalId: string;
  sourceType: SignalType;
  subjectId: string;
  rawText?: string;
  priorityHint?: CasePriority;
}

export type SignalIntakeOutcome = "case_created" | "linked" | "pending" | "replay";

export interface SignalIntakeResult {
  outcome: SignalIntakeOutcome;
  signal: SignalRecord;
  caseId: string | null;
}

export interface ManualCaseInput {
  /**
   * Client-generated idempotency key. Re-submitting the same key (double
   * tap, retry after a network error) returns the original Case instead of
   * creating a duplicate.
   */
  clientRequestId?: string;
  facilityId: string;
  subjectId: string;
  sourceType: SignalType;
  priority: CasePriority;
  category?: string;
  priorityRationale?: string;
  rawText?: string;
}

export interface CaseFromSignalInput {
  priority: CasePriority;
  category?: string;
  priorityRationale?: string;
}

export interface SettingsPatch {
  displayName?: string;
  sla?: CaseSlaPolicy;
  approveSla?: { note?: string };
  escalationRules?: FacilityEscalationRule[];
  autoCreateCaseFor?: SignalType[];
  linkDuplicateSignals?: boolean;
  categories?: string[];
}

export interface AiReviewInput {
  decision: "approve" | "reject";
  text?: string;
  note?: string;
  acknowledgeUnverified?: boolean;
  expectedVersion: number;
}

export interface CaseDetailProjection {
  aggregate: CaseAggregate;
  events: readonly CaseEvent[];
  capabilities: CaseCapabilitiesProjection;
  auditTrail: CaseAuditEntry[];
  /** Evidence references across the whole history (notes + resolution). */
  evidence: CaseEvidenceEntry[];
  signals: SignalRecord[];
  drafts: AiDraft[];
  sla: CaseSlaEvaluation;
  slaApproved: boolean;
  aiAvailable: boolean;
  /** Whether the accountable people can still act on this Case. */
  ownership: {
    assigneeUnavailable: boolean;
    handoffTargetUnavailable: boolean;
  };
}

export interface EscalationRunResult {
  evaluatedCases: number;
  enqueued: number;
  suppressedDuplicates: number;
  delivery: OutboxRunResult;
}

export type UnifiedAuditEntry =
  | ({ source: "case_event" } & CaseAuditEntry & { facilityId: string | null })
  | ({ source: "platform" } & PlatformAuditEntry);

/** Default initial priority when a signal opens a Case without a human. */
const SIGNAL_DEFAULT_PRIORITY: Record<SignalType, CasePriority> = {
  sos: "critical",
  crisis_no_response: "critical",
  unwell: "high",
  non_response: "high",
  welfare_need_help: "normal",
  snow_report: "normal",
  free_text: "normal",
  manual: "normal",
  external_api: "normal",
};

const NOTE_TEXT_MAX = 4000;
/**
 * 0 for the first notification, n for the n-th re-notification that is
 * due now. Bounded so a forgotten Case cannot generate unbounded noise.
 */
export function escalationRepeatIndex(rule: FacilityEscalationRule, elapsedMs: number): number {
  const every = rule.repeatEveryMinutes ?? 0;
  if (!Number.isFinite(every) || every <= 0) return 0;
  const max = Math.min(Math.max(0, rule.maxRepeats ?? 3), MAX_ESCALATION_REPEATS);
  return Math.min(max, Math.max(0, Math.floor(elapsedMs / (every * 60_000))));
}

const SCAN_PAGE = 500;
const SCAN_CAP = 5000;
const COLUMN_SORTS: readonly string[] = ["createdAt", "lastActivityAt", "priority", "status"];

/** Same text at creation and in periodic runs (same delivery key). */
function criticalMessage(caseId: string): string {
  return `重大(critical)のCase ${caseId} が未確認です。職員による確認が必要です。`;
}

function requireText(value: string | undefined, label: string, max: number): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new CareOpsRuleError("INVALID_INPUT", `${label} is required`);
  if (normalized.length > max) throw new CareOpsRuleError("INVALID_INPUT", `${label} is too long`);
  return normalized;
}

function optionalText(value: string | undefined, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized.slice(0, max);
}

function openOnlyEmpty(filter: CaseListFilter): boolean {
  return Boolean(
    filter.openOnly &&
    filter.statuses?.length &&
    !filter.statuses.some((status) => OPEN_STATUSES.includes(status)),
  );
}

export class CareOpsPlatformService {
  readonly #repository: CaseRepository;
  readonly #memberships: TenantMembershipDirectory;
  readonly #signals: SignalStore;
  readonly #settings: FacilitySettingsStore;
  readonly #audit: AuditLogStore;
  readonly #drafts: AiDraftStore;
  readonly #outbox: ListableOutboxStore;
  readonly #inbox: StaffNotificationInbox;
  readonly #channels: StaffNotificationChannel[];
  readonly #ai: AiDraftProvider;
  readonly #aiTimeoutMs: number;
  readonly #now: () => string;
  readonly #newId: () => string;
  readonly #fallbackSla: CaseSlaPolicy;
  readonly #worker: OutboxWorker;
  readonly caseService: CaseService;

  constructor(options: CareOpsPlatformOptions) {
    this.#repository = options.repository;
    this.#memberships = options.memberships;
    this.#signals = options.signals;
    this.#settings = options.settings;
    this.#audit = options.audit;
    this.#drafts = options.drafts;
    this.#outbox = options.outbox;
    this.#inbox = options.inbox;
    this.#ai = options.ai ?? new DisabledAiDraftProvider();
    this.#aiTimeoutMs = options.aiTimeoutMs ?? 15_000;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#newId = options.newId ?? (() => crypto.randomUUID());
    this.#fallbackSla = options.fallbackSlaPolicy ?? PROVISIONAL_SLA_POLICY;
    validateSlaPolicy(this.#fallbackSla);

    const inbox = this.#inbox;
    this.#channels = [
      { name: "in-app", deliver: async (notification) => { await inbox.deliver(notification); } },
      ...(options.channels ?? []),
    ];

    this.caseService = new CaseService(this.#repository, this.#memberships, this.#now);
    this.#worker = new OutboxWorker(
      this.#outbox,
      [{ topic: STAFF_NOTIFICATION_TOPIC, deliver: (message) => this.#deliverNotification(message.tenantId, message.id, message.payload) }],
      { retryDelayMs: options.notificationRetryDelayMs ?? 60_000, now: this.#now },
    );
  }

  /* ---------------------------- identity ---------------------------- */

  async #member(ctx: PlatformContext): Promise<TenantMembership> {
    const membership = await this.#memberships.findByPrincipal(ctx.tenantId, ctx.principalId);
    assertActiveMembership(membership);
    return membership;
  }

  async #memberWith(ctx: PlatformContext, permission: PlatformPermission, reason: ConstructorParameters<typeof CaseAccessDeniedError>[0] = "command_forbidden"): Promise<TenantMembership> {
    const membership = await this.#member(ctx);
    if (!hasPlatformPermission(membership, permission)) {
      throw new CaseAccessDeniedError(reason);
    }
    return membership;
  }

  async #facility(tenantId: string, facilityId: string): Promise<FacilitySettings> {
    const settings = await this.#settings.get(tenantId, facilityId);
    if (!settings) throw new CareOpsNotFoundError("facility");
    // Settings stored before a trigger existed show its default rule.
    return { ...settings, escalationRules: effectiveEscalationRules(settings.escalationRules) };
  }

  async #policyResolver(tenantId: string): Promise<{ resolve: SlaPolicyResolver; approved: (facilityId: string | null) => boolean }> {
    const all = await this.#settings.list(tenantId);
    const byId = new Map(all.map((settings) => [settings.facilityId, settings]));
    return {
      resolve: (facilityId) => (facilityId ? byId.get(facilityId)?.sla : undefined) ?? this.#fallbackSla,
      approved: (facilityId) => (facilityId ? byId.get(facilityId)?.slaApproval.status === "approved" : false),
    };
  }

  async #search(query: CaseSearchQuery): Promise<CaseSearchResult> {
    if (isSearchableCaseRepository(this.#repository)) return this.#repository.search(query);
    // Repositories without native search fall back to the reference semantics.
    return applyCaseSearch(await this.#repository.list(query.tenantId), query);
  }

  /** Visibility derived exclusively from the server-side membership. */
  #scopeOf(membership: TenantMembership): Pick<CaseSearchQuery, "tenantId" | "facilityScope" | "visibleToActor"> {
    return {
      tenantId: membership.tenantId,
      facilityScope: membership.facilityIds?.length ? [...membership.facilityIds] : null,
      visibleToActor: queueVisibilityForMembership(membership) === "responder" ? membership.actorId : null,
    };
  }

  /**
   * Resolves whether the owners (assignee / handoff target) of the given
   * Cases can still act: active membership, an assignable role, and
   * facility scope covering the Case. One directory lookup per actor.
   */
  async #availabilityFor(tenantId: string, cases: readonly StoredCase[]): Promise<AvailabilityCheck> {
    const actors = new Set<string>();
    for (const stored of cases) {
      if (stored.aggregate.assigneeId) actors.add(stored.aggregate.assigneeId);
      if (stored.aggregate.handoffTargetId) actors.add(stored.aggregate.handoffTargetId);
    }
    const members = new Map<string, TenantMembership | null>();
    await Promise.all([...actors].map(async (actorId) => {
      members.set(actorId, await this.#memberships.findByActorId(tenantId, actorId));
    }));
    return (actorId, facilityId) => {
      const member = members.get(actorId);
      // Actors outside the resolved set are not judged.
      if (member === undefined) return true;
      return Boolean(
        member &&
        member.active &&
        member.roles.some((role) => role === "responder" || role === "supervisor") &&
        membershipCoversFacility(member, facilityId),
      );
    };
  }

  /**
   * Bounded scan for views that must evaluate SLA in memory. Exceeding the
   * bound is reported explicitly instead of silently truncating results.
   */
  async #visibleCases(
    membership: TenantMembership,
    filter: Partial<Omit<CaseSearchQuery, "tenantId" | "facilityScope" | "visibleToActor" | "limit" | "offset">>,
    cap = SCAN_CAP,
  ): Promise<StoredCase[]> {
    const result: StoredCase[] = [];
    for (let offset = 0; ; offset += SCAN_PAGE) {
      const page = await this.#search({
        ...this.#scopeOf(membership),
        sort: "createdAt",
        order: "asc",
        ...filter,
        limit: SCAN_PAGE,
        offset,
      });
      if (page.total > cap) {
        throw new CareOpsRuleError("RESULT_TOO_LARGE", "Too many Cases for this view; narrow the filters or period");
      }
      // Defense in depth: the store already applied visibility.
      result.push(...page.cases.filter((stored) => canReadCaseAggregate(membership, stored.aggregate)));
      if (offset + SCAN_PAGE >= page.total) return result;
    }
  }

  #assertFacilityFilter(membership: TenantMembership, facilityId: string | undefined | null): void {
    if (facilityId) assertFacilityInScope(membership, facilityId);
  }

  async #recordAudit(entry: Omit<PlatformAuditEntry, "id" | "at">): Promise<void> {
    await this.#audit.append({ ...entry, id: this.#newId(), at: this.#now() });
  }

  /* ---------------------------- operator ---------------------------- */

  async operator(ctx: PlatformContext) {
    const membership = await this.#member(ctx);
    const facilities = (await this.#settings.list(ctx.tenantId))
      .filter((settings) => membershipCoversFacility(membership, settings.facilityId))
      .map((settings) => ({
        facilityId: settings.facilityId,
        displayName: settings.displayName,
        slaApproved: settings.slaApproval.status === "approved",
        categories: [...settings.categories],
      }));
    const permissions = Object.fromEntries(
      (Object.keys(PLATFORM_PERMISSION_ROLES) as PlatformPermission[]).map((permission) => [
        permission,
        hasPlatformPermission(membership, permission),
      ]),
    ) as Record<PlatformPermission, boolean>;

    return {
      tenantId: membership.tenantId,
      actorId: membership.actorId,
      roles: [...membership.roles],
      queueVisibility: queueVisibilityForMembership(membership),
      facilityScope: membership.facilityIds?.length ? [...membership.facilityIds] : null,
      facilities,
      permissions,
      aiAvailable: this.#ai.name !== "disabled",
    };
  }

  permissionsMatrix() {
    return {
      roles: [...STAFF_ROLES],
      caseCommands: structuredClone(COMMAND_ROLES),
      platform: structuredClone(PLATFORM_PERMISSION_ROLES),
    };
  }

  async permissions(ctx: PlatformContext) {
    await this.#member(ctx);
    return this.permissionsMatrix();
  }

  async staff(ctx: PlatformContext, facilityId?: string) {
    const membership = await this.#member(ctx);
    this.#assertFacilityFilter(membership, facilityId);
    const roster = this.#memberships.listByTenant
      ? await this.#memberships.listByTenant(ctx.tenantId)
      : [];
    return roster
      .filter((member) => member.active)
      .filter((member) =>
        // Never reveal staff outside the caller's own facility scope.
        (membership.facilityIds?.length
          ? (member.facilityIds?.length
              ? member.facilityIds.some((id) => membership.facilityIds!.includes(id))
              : true)
          : true),
      )
      .filter((member) => !facilityId || membershipCoversFacility(member, facilityId))
      .map((member) => ({
        actorId: member.actorId,
        roles: [...member.roles],
        facilityIds: member.facilityIds?.length ? [...member.facilityIds] : null,
        assignable: member.roles.some((role) => role === "responder" || role === "supervisor"),
      }));
  }

  /* ---------------------------- settings ---------------------------- */

  async facilities(ctx: PlatformContext) {
    const membership = await this.#member(ctx);
    return (await this.#settings.list(ctx.tenantId)).filter((settings) =>
      membershipCoversFacility(membership, settings.facilityId),
    );
  }

  async getSettings(ctx: PlatformContext, facilityId: string): Promise<FacilitySettings> {
    const membership = await this.#member(ctx);
    assertFacilityInScope(membership, facilityId);
    return this.#facility(ctx.tenantId, facilityId);
  }

  async updateSettings(
    ctx: PlatformContext,
    facilityId: string,
    expectedVersion: number,
    patch: SettingsPatch,
  ): Promise<FacilitySettings> {
    const membership = await this.#memberWith(ctx, "manage_settings", "settings_forbidden");
    assertFacilityInScope(membership, facilityId);
    const current = await this.#facility(ctx.tenantId, facilityId);
    if (current.version !== expectedVersion) {
      throw new CareOpsConflictError("Settings were changed by someone else");
    }

    const next: FacilitySettings = structuredClone(current);
    if (patch.displayName !== undefined) next.displayName = requireText(patch.displayName, "displayName", 100);
    if (patch.sla) {
      validateSlaPolicy(patch.sla);
      next.sla = structuredClone(patch.sla);
      if (JSON.stringify(current.sla) !== JSON.stringify(next.sla)) {
        // A threshold change always requires a fresh facility approval.
        next.slaApproval = { status: "unapproved", approvedBy: null, approvedAt: null, note: null };
      }
    }
    if (patch.escalationRules) next.escalationRules = structuredClone(patch.escalationRules);
    if (patch.autoCreateCaseFor) next.autoCreateCaseFor = [...new Set(patch.autoCreateCaseFor)];
    if (patch.linkDuplicateSignals !== undefined) next.linkDuplicateSignals = patch.linkDuplicateSignals;
    if (patch.categories) {
      next.categories = [...new Set(patch.categories.map((item) => requireText(item, "category", 64)))].slice(0, 50);
    }
    if (patch.approveSla) {
      next.slaApproval = {
        status: "approved",
        approvedBy: membership.actorId,
        approvedAt: this.#now(),
        note: optionalText(patch.approveSla.note, 500) ?? null,
      };
    }
    next.version = current.version + 1;
    next.updatedAt = this.#now();
    next.updatedBy = membership.actorId;

    if (!(await this.#settings.save(next, current.version))) {
      throw new CareOpsConflictError("Settings were changed by someone else");
    }
    await this.#recordAudit({
      tenantId: ctx.tenantId,
      facilityId,
      actorId: membership.actorId,
      action: patch.approveSla ? "settings.updated_and_sla_approved" : "settings.updated",
      targetType: "settings",
      targetId: facilityId,
      before: current,
      after: next,
      reason: optionalText(patch.approveSla?.note, 500) ?? null,
    });
    return next;
  }

  /**
   * Operator provisioning (server-side tooling only, never exposed over
   * HTTP). Creates a facility with PROVISIONAL, unapproved thresholds.
   * Idempotent: an existing facility is left untouched.
   */
  async provisionFacility(input: { tenantId: string; facilityId: string; displayName: string; operator: string }): Promise<{ created: boolean; settings: FacilitySettings }> {
    const facilityId = requireText(input.facilityId, "facilityId", 128);
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(facilityId)) throw new CareOpsRuleError("INVALID_INPUT", "facilityId has invalid format");
    const existing = await this.#settings.get(input.tenantId, facilityId);
    if (existing) return { created: false, settings: existing };
    const settings = defaultFacilitySettings({
      tenantId: input.tenantId,
      facilityId,
      displayName: requireText(input.displayName, "displayName", 100),
      now: this.#now(),
    });
    if (!(await this.#settings.save(settings, 0))) {
      return { created: false, settings: (await this.#settings.get(input.tenantId, facilityId))! };
    }
    await this.#recordAudit({
      tenantId: input.tenantId,
      facilityId,
      actorId: `provisioning:${requireText(input.operator, "operator", 64)}`,
      action: "settings.facility_provisioned",
      targetType: "settings",
      targetId: facilityId,
      before: null,
      after: settings,
      reason: "operator provisioning",
    });
    return { created: true, settings };
  }

  /* ----------------------------- signals ---------------------------- */

  /**
   * Trusted server-side intake for adapters (LINE webhook, sensors…).
   * The adapter's own credential must determine tenantId; never accept
   * it from an unauthenticated request body.
   */
  async ingestFromAdapter(tenantId: string, input: SignalIntakeInput): Promise<SignalIntakeResult> {
    return this.#ingest(tenantId, input, null);
  }

  /** Staff-entered notification (phone call, message read aloud…). */
  async ingestSignal(ctx: PlatformContext, input: SignalIntakeInput): Promise<SignalIntakeResult> {
    const membership = await this.#memberWith(ctx, "ingest_signal", "intake_forbidden");
    assertFacilityInScope(membership, input.facilityId);
    return this.#ingest(ctx.tenantId, input, membership.actorId);
  }

  async #ingest(tenantId: string, input: SignalIntakeInput, actorId: string | null): Promise<SignalIntakeResult> {
    const settings = await this.#facility(tenantId, input.facilityId);
    const existing = await this.#signals.findBySource(tenantId, input.sourceAdapter, input.sourceSignalId);
    if (existing) {
      await this.#signals.incrementReplay(tenantId, existing.id);
      return { outcome: "replay", signal: (await this.#signals.get(tenantId, existing.id))!, caseId: existing.caseId };
    }

    const record: SignalRecord = {
      id: `sig-${this.#newId()}`,
      tenantId,
      facilityId: settings.facilityId,
      sourceAdapter: requireText(input.sourceAdapter, "sourceAdapter", 64),
      sourceSignalId: requireText(input.sourceSignalId, "sourceSignalId", 128),
      sourceType: input.sourceType,
      subjectId: requireText(input.subjectId, "subjectId", 128),
      receivedAt: this.#now(),
      rawText: optionalText(input.rawText, 4000) ?? null,
      priorityHint: input.priorityHint ?? null,
      disposition: "pending",
      caseId: null,
      decidedBy: null,
      decidedAt: null,
      dismissReason: null,
      replayCount: 0,
      receivedBy: actorId,
    };
    const inserted = await this.#signals.insert(record);
    if (!inserted.created) {
      await this.#signals.incrementReplay(tenantId, inserted.record.id);
      return { outcome: "replay", signal: inserted.record, caseId: inserted.record.caseId };
    }

    if (settings.linkDuplicateSignals) {
      const linked = await this.#linkToOpenCase(inserted.record, actorId);
      if (linked) return linked;
    }

    if (settings.autoCreateCaseFor.includes(input.sourceType)) {
      const opened = await this.#openCaseFromSignal(inserted.record, null, {
        priority: input.priorityHint ?? SIGNAL_DEFAULT_PRIORITY[input.sourceType],
      });
      return { outcome: "case_created", signal: opened.signal, caseId: opened.aggregate.id };
    }

    await this.#recordAudit({
      tenantId,
      facilityId: record.facilityId,
      actorId,
      action: "signal.received_pending",
      targetType: "signal",
      targetId: record.id,
      before: null,
      after: { disposition: "pending", sourceType: record.sourceType },
      reason: null,
    });
    return { outcome: "pending", signal: inserted.record, caseId: null };
  }

  async #linkToOpenCase(record: SignalRecord, actorId: string | null): Promise<SignalIntakeResult | null> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const found = await this.#search({
        tenantId: record.tenantId,
        facilityScope: null,
        visibleToActor: null,
        subjectId: record.subjectId,
        ...(record.facilityId ? { facilityId: record.facilityId } : {}),
        statuses: OPEN_STATUSES,
        sort: "createdAt",
        order: "desc",
        limit: 1,
        offset: 0,
      });
      const target = found.cases[0];
      if (!target || (target.aggregate.facilityId ?? null) !== record.facilityId) return null;

      try {
        const linked = linkSignalToCase(
          target.aggregate,
          target.aggregate.version,
          { sourceAdapter: record.sourceAdapter, sourceSignalId: record.sourceSignalId, sourceType: record.sourceType, linkedBy: actorId },
          this.#now(),
        );
        await this.#repository.append({
          tenantId: record.tenantId,
          caseId: target.aggregate.id,
          expectedVersion: target.aggregate.version,
          event: linked.event,
        });
        const updated: SignalRecord = {
          ...record,
          disposition: "linked",
          caseId: target.aggregate.id,
          decidedBy: actorId,
          decidedAt: this.#now(),
        };
        await this.#signals.updateDisposition(updated, "pending");
        await this.#recordAudit({
          tenantId: record.tenantId,
          facilityId: record.facilityId,
          actorId,
          action: "signal.linked_to_open_case",
          targetType: "signal",
          targetId: record.id,
          before: { disposition: "pending" },
          after: { disposition: "linked", caseId: target.aggregate.id },
          reason: "同一対象者の未完了Caseが存在するため重複通知として紐付け",
        });
        return { outcome: "linked", signal: updated, caseId: target.aggregate.id };
      } catch (error) {
        if (error instanceof CaseConflictError) continue;
        throw error;
      }
    }
    throw new CareOpsConflictError("Could not link signal due to concurrent updates");
  }

  async #openCaseFromSignal(
    record: SignalRecord,
    actorId: string | null,
    input: CaseFromSignalInput,
  ): Promise<{ aggregate: CaseAggregate; signal: SignalRecord; replayed: boolean }> {
    const humanRationale = optionalText(input.priorityRationale, 1000);
    const created = createCase({
      id: `case-${this.#newId()}`,
      tenantId: record.tenantId,
      ...(record.facilityId ? { facilityId: record.facilityId } : {}),
      subjectId: record.subjectId,
      sourceType: record.sourceType,
      sourceAdapter: record.sourceAdapter,
      sourceSignalId: record.sourceSignalId,
      priority: input.priority,
      ...(optionalText(input.category, 64) ? { category: optionalText(input.category, 64)! } : {}),
      priorityRationale: humanRationale ??
        (actorId
          ? "根拠未入力（トリアージで設定してください）"
          : `通知種別(${record.sourceType})に基づく自動初期値。人による確認とトリアージが必要`),
      createdAt: this.#now(),
      ...(actorId ? { createdBy: actorId } : {}),
    });
    const stored = await this.#repository.create(created.event);

    const updated: SignalRecord = {
      ...record,
      disposition: "case_created",
      caseId: stored.aggregate.id,
      decidedBy: actorId,
      decidedAt: this.#now(),
    };
    const won = await this.#signals.updateDisposition(updated, "pending");
    if (!won) {
      const current = await this.#signals.get(record.tenantId, record.id);
      if (current?.disposition !== "case_created" || current.caseId !== stored.aggregate.id) {
        throw new CareOpsConflictError("Signal was decided concurrently");
      }
    }
    await this.#recordAudit({
      tenantId: record.tenantId,
      facilityId: record.facilityId,
      actorId,
      action: "signal.case_created",
      targetType: "signal",
      targetId: record.id,
      before: { disposition: "pending" },
      after: { disposition: "case_created", caseId: stored.aggregate.id },
      reason: null,
    });

    if (stored.created && stored.aggregate.priority === "critical") {
      await this.#enqueueCritical(stored.aggregate);
    }
    return { aggregate: stored.aggregate, signal: updated, replayed: false };
  }

  async listSignals(ctx: PlatformContext, disposition?: SignalDisposition): Promise<SignalRecord[]> {
    const membership = await this.#member(ctx);
    const records = await this.#signals.list(ctx.tenantId, disposition ? { disposition } : {});
    return records.filter((record) => membershipCoversFacility(membership, record.facilityId));
  }

  async #visibleSignal(membership: TenantMembership, signalId: string): Promise<SignalRecord> {
    const record = await this.#signals.get(membership.tenantId, signalId);
    // Out-of-scope records are reported as missing (no existence oracle).
    if (!record || !membershipCoversFacility(membership, record.facilityId)) {
      throw new CareOpsNotFoundError("signal");
    }
    return record;
  }

  async createCaseFromSignal(ctx: PlatformContext, signalId: string, input: CaseFromSignalInput) {
    const membership = await this.#memberWith(ctx, "create_case", "intake_forbidden");
    const record = await this.#visibleSignal(membership, signalId);
    if (record.disposition !== "pending") {
      throw new CareOpsConflictError(`Signal is already ${record.disposition}`);
    }
    return this.#openCaseFromSignal(record, membership.actorId, input);
  }

  async dismissSignal(ctx: PlatformContext, signalId: string, reason: string): Promise<SignalRecord> {
    const membership = await this.#memberWith(ctx, "decide_signal", "intake_forbidden");
    const record = await this.#visibleSignal(membership, signalId);
    const normalized = requireText(reason, "reason", 1000);
    if (record.disposition !== "pending") {
      throw new CareOpsConflictError(`Signal is already ${record.disposition}`);
    }
    const updated: SignalRecord = {
      ...record,
      disposition: "dismissed",
      dismissReason: normalized,
      decidedBy: membership.actorId,
      decidedAt: this.#now(),
    };
    if (!(await this.#signals.updateDisposition(updated, "pending"))) {
      throw new CareOpsConflictError("Signal was decided concurrently");
    }
    await this.#recordAudit({
      tenantId: ctx.tenantId,
      facilityId: record.facilityId,
      actorId: membership.actorId,
      action: "signal.dismissed",
      targetType: "signal",
      targetId: record.id,
      before: { disposition: "pending" },
      after: { disposition: "dismissed" },
      reason: normalized,
    });
    return updated;
  }

  /** Manual Case creation from a notification staff received directly. */
  async createCase(ctx: PlatformContext, input: ManualCaseInput) {
    const membership = await this.#memberWith(ctx, "create_case", "intake_forbidden");
    assertFacilityInScope(membership, input.facilityId);
    const settings = await this.#facility(ctx.tenantId, input.facilityId);

    const record: SignalRecord = {
      id: `sig-${this.#newId()}`,
      tenantId: ctx.tenantId,
      facilityId: settings.facilityId,
      sourceAdapter: "staff-entry",
      sourceSignalId: input.clientRequestId
        ? `manual-${membership.actorId}-${input.clientRequestId}`
        : `manual-${this.#newId()}`,
      sourceType: input.sourceType,
      subjectId: requireText(input.subjectId, "subjectId", 128),
      receivedAt: this.#now(),
      rawText: optionalText(input.rawText, 4000) ?? null,
      priorityHint: input.priority,
      disposition: "pending",
      caseId: null,
      decidedBy: null,
      decidedAt: null,
      dismissReason: null,
      replayCount: 0,
      receivedBy: membership.actorId,
    };
    const inserted = await this.#signals.insert(record);
    if (!inserted.created) {
      // Idempotent replay of the same client request.
      const existing = inserted.record;
      if (existing.subjectId !== record.subjectId || existing.facilityId !== record.facilityId || existing.sourceType !== record.sourceType) {
        throw new CareOpsConflictError("clientRequestId was reused for a different request");
      }
      if (!existing.caseId) throw new CareOpsConflictError("The original request is still being processed; retry shortly");
      const stored = await this.caseService.get({ tenantId: ctx.tenantId, caseId: existing.caseId, principalId: ctx.principalId });
      if (!stored) throw new CaseNotFoundError(ctx.tenantId, existing.caseId);
      return { aggregate: stored.aggregate, signal: existing, replayed: true };
    }
    return this.#openCaseFromSignal(record, membership.actorId, {
      priority: input.priority,
      ...(input.category ? { category: input.category } : {}),
      ...(input.priorityRationale ? { priorityRationale: input.priorityRationale } : {}),
    });
  }

  /* ------------------------------ cases ----------------------------- */

  async execute(
    ctx: PlatformContext,
    caseId: string,
    expectedVersion: number,
    command: CaseCommandIntent,
  ): Promise<CaseOperationResult> {
    const result = await this.caseService.execute({
      tenantId: ctx.tenantId,
      caseId,
      principalId: ctx.principalId,
      expectedVersion,
      command,
    });
    if (result.event.type === "escalated") {
      await this.#enqueueNotification(result.aggregate, {
        kind: "manual_escalation",
        deliveryKey: `manual:${caseId}:${result.event.sequence}`,
        recipientRoles: ["supervisor"],
        message: `Case ${caseId} が職員によりエスカレーションされました（優先度 ${result.aggregate.priority}）`,
      });
      await this.#deliverPending(ctx.tenantId);
    }
    return result;
  }

  async listCases(ctx: PlatformContext, filter: CaseListFilter): Promise<CaseListPage> {
    const membership = await this.#member(ctx);
    this.#assertFacilityFilter(membership, filter.facilityId);
    const { resolve } = await this.#policyResolver(ctx.tenantId);
    const statuses = filter.openOnly
      ? OPEN_STATUSES.filter((status) => !filter.statuses?.length || filter.statuses.includes(status))
      : filter.statuses;
    const structural: Partial<CaseSearchQuery> = {
      ...(statuses ? { statuses } : {}),
      ...(filter.priorities?.length ? { priorities: filter.priorities } : {}),
      ...(filter.assigneeId ? { assigneeId: filter.assigneeId } : {}),
      ...(filter.facilityId ? { facilityId: filter.facilityId } : {}),
      ...(filter.escalated !== undefined ? { escalated: filter.escalated } : {}),
      ...(filter.createdFrom ? { createdFrom: filter.createdFrom } : {}),
      ...(filter.createdTo ? { createdTo: filter.createdTo } : {}),
      ...(filter.query ? { query: filter.query } : {}),
    };
    if (openOnlyEmpty(filter)) {
      return { items: [], page: 1, pageSize: Math.min(filter.pageSize ?? 20, 100), total: 0, totalPages: 1, evaluatedAt: this.#now() };
    }

    const sort = filter.sort ?? "attention";
    if (COLUMN_SORTS.includes(sort) && filter.breached === undefined) {
      // Fully server-side: filtering, ordering and paging in the store.
      const pageSize = Math.min(Math.max(1, Math.trunc(filter.pageSize ?? 20)), 100);
      const requested = Math.max(1, Math.trunc(filter.page ?? 1));
      const query = (page: number): CaseSearchQuery => ({
        ...this.#scopeOf(membership),
        ...structural,
        sort: sort as CaseSearchSort,
        order: filter.order ?? "asc",
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
      let result = await this.#search(query(requested));
      const totalPages = Math.max(1, Math.ceil(result.total / pageSize));
      const page = Math.min(requested, totalPages);
      if (page !== requested) result = await this.#search(query(page));
      const now = this.#now();
      const pageCases = result.cases.filter((stored) => canReadCaseAggregate(membership, stored.aggregate));
      const isAvailable = await this.#availabilityFor(ctx.tenantId, pageCases);
      return {
        items: pageCases.map((stored) => toCaseListItem(stored, resolve, now, isAvailable)),
        page,
        pageSize,
        total: result.total,
        totalPages,
        evaluatedAt: now,
      };
    }
    // SLA-dependent ordering/filtering: bounded scan, then in-memory ranking.
    const scanned = await this.#visibleCases(membership, structural, 2000);
    return searchCases(scanned, filter, resolve, this.#now(), await this.#availabilityFor(ctx.tenantId, scanned));
  }

  async dashboard(ctx: PlatformContext, facilityId?: string): Promise<CareOpsDashboard> {
    const membership = await this.#member(ctx);
    this.#assertFacilityFilter(membership, facilityId);
    const { resolve } = await this.#policyResolver(ctx.tenantId);
    const pending = (await this.listSignals(ctx, "pending")).filter(
      (signal) => !facilityId || signal.facilityId === facilityId,
    ).length;
    const counted = async (status: "COMPLETED" | "CLOSED") =>
      (await this.#search({ ...this.#scopeOf(membership), statuses: [status], ...(facilityId ? { facilityId } : {}), sort: "createdAt", order: "asc", limit: 1, offset: 0 })).total;
    const openCases = await this.#visibleCases(membership, { statuses: OPEN_STATUSES, ...(facilityId ? { facilityId } : {}) });
    const dashboard = projectDashboard({
      cases: openCases,
      policyFor: resolve,
      now: this.#now(),
      actorId: membership.actorId,
      facilityId: facilityId ?? null,
      pendingSignals: pending,
      isAvailable: await this.#availabilityFor(ctx.tenantId, openCases),
      delivery: hasPlatformPermission(membership, "run_escalation")
        ? await this.#deliveryProblems(membership, facilityId)
        : null,
    });
    // Resolved / closed are counted in the store (not loaded).
    dashboard.counts.resolved = await counted("COMPLETED");
    dashboard.counts.closed = await counted("CLOSED");
    return dashboard;
  }

  async caseDetail(ctx: PlatformContext, caseId: string): Promise<CaseDetailProjection> {
    const query = { tenantId: ctx.tenantId, caseId, principalId: ctx.principalId };
    const stored = await this.caseService.get(query);
    if (!stored) throw new CaseNotFoundError(ctx.tenantId, caseId);
    const capabilities = await this.caseService.capabilities(query);
    const { resolve, approved } = await this.#policyResolver(ctx.tenantId);
    const facilityId = stored.aggregate.facilityId ?? null;

    return {
      aggregate: stored.aggregate,
      events: stored.events,
      capabilities,
      auditTrail: projectCaseAuditTrail(stored.events),
      evidence: projectCaseEvidence(stored.events),
      signals: await this.#signals.list(ctx.tenantId, { caseId }),
      drafts: await this.#drafts.listByCase(ctx.tenantId, caseId),
      sla: evaluateCaseSla(stored.aggregate, stored.events, resolve(facilityId), this.#now()),
      slaApproved: approved(facilityId),
      aiAvailable: this.#ai.name !== "disabled",
      ownership: await this.#ownership(stored),
    };
  }

  async #ownership(stored: StoredCase): Promise<CaseDetailProjection["ownership"]> {
    const aggregate = stored.aggregate;
    if (!OPEN_STATUSES.includes(aggregate.status)) {
      return { assigneeUnavailable: false, handoffTargetUnavailable: false };
    }
    const isAvailable = await this.#availabilityFor(aggregate.tenantId, [stored]);
    const facilityId = aggregate.facilityId ?? null;
    return {
      assigneeUnavailable: Boolean(aggregate.assigneeId && !isAvailable(aggregate.assigneeId, facilityId)),
      handoffTargetUnavailable: Boolean(aggregate.handoffTargetId && !isAvailable(aggregate.handoffTargetId, facilityId)),
    };
  }

  async handoffBoard(ctx: PlatformContext): Promise<HandoffBoard> {
    const membership = await this.#memberWith(ctx, "view_handoff_board");
    const { resolve } = await this.#policyResolver(ctx.tenantId);
    const now = this.#now();
    const active = await this.#visibleCases(membership, { statuses: ["HANDOFF_PENDING", "ASSIGNED", "IN_PROGRESS"] });
    const recent = await this.#visibleCases(membership, { activityFrom: new Date(Date.parse(now) - 24 * 3_600_000).toISOString() });
    const merged = new Map([...active, ...recent].map((stored) => [stored.aggregate.id, stored]));
    return projectHandoffBoard({
      cases: [...merged.values()],
      policyFor: resolve,
      now: this.#now(),
      actorId: membership.actorId,
    });
  }

  async analytics(ctx: PlatformContext, input: { from: string; to: string; facilityId?: string }): Promise<CareOpsAnalytics> {
    const membership = await this.#memberWith(ctx, "view_analytics", "analytics_forbidden");
    this.#assertFacilityFilter(membership, input.facilityId);
    const { resolve } = await this.#policyResolver(ctx.tenantId);
    const signals = (await this.#signals.list(ctx.tenantId, {
      receivedFrom: new Date(Date.parse(input.from)).toISOString(),
      receivedTo: new Date(Date.parse(input.to)).toISOString(),
    })).filter((signal) => membershipCoversFacility(membership, signal.facilityId));
    try {
      return computeCareOpsAnalytics({
        cases: await this.#analyticsCases(membership, input),
        signals,
        from: input.from,
        to: input.to,
        facilityId: input.facilityId ?? null,
        policyFor: resolve,
        now: this.#now(),
      });
    } catch (error) {
      throw new CareOpsRuleError("INVALID_PERIOD", error instanceof Error ? error.message : "invalid period");
    }
  }

  async #analyticsCases(membership: TenantMembership, input: { from: string; to: string; facilityId?: string }): Promise<StoredCase[]> {
    const facility = input.facilityId ? { facilityId: input.facilityId } : {};
    // Cases with any event in the period, plus Cases still open at the end.
    const touched = await this.#visibleCases(membership, { ...facility, createdTo: input.to, activityFrom: input.from }, 20_000);
    const open = await this.#visibleCases(membership, { ...facility, createdTo: input.to, statuses: OPEN_STATUSES }, 20_000);
    return [...new Map([...touched, ...open].map((stored) => [stored.aggregate.id, stored])).values()];
  }

  async auditLog(ctx: PlatformContext, options: { limit?: number; facilityId?: string } = {}): Promise<UnifiedAuditEntry[]> {
    const membership = await this.#memberWith(ctx, "view_audit_log", "audit_forbidden");
    this.#assertFacilityFilter(membership, options.facilityId);
    const limit = Math.min(Math.max(1, options.limit ?? 200), 1000);

    // Most recently active Cases first; enough to fill the requested window.
    const recentCases = (await this.#search({
      ...this.#scopeOf(membership),
      ...(options.facilityId ? { facilityId: options.facilityId } : {}),
      sort: "lastActivityAt",
      order: "desc",
      limit: Math.min(limit, 500),
      offset: 0,
    })).cases.filter((stored) => canReadCaseAggregate(membership, stored.aggregate));
    const caseEntries: UnifiedAuditEntry[] = recentCases
      .flatMap((stored) =>
        projectCaseAuditTrail(stored.events).map((entry) => ({
          source: "case_event" as const,
          ...entry,
          facilityId: stored.aggregate.facilityId ?? null,
        })),
      );
    const platformEntries: UnifiedAuditEntry[] = (await this.#audit.list(ctx.tenantId, { limit: 1000 }))
      .filter((entry) => membershipCoversFacility(membership, entry.facilityId))
      .filter((entry) => !options.facilityId || entry.facilityId === options.facilityId)
      .map((entry) => ({ source: "platform" as const, ...entry }));

    return [...caseEntries, ...platformEntries]
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, limit);
  }

  /* -------------------------- notifications ------------------------- */

  async notifications(ctx: PlatformContext): Promise<StaffNotification[]> {
    const membership = await this.#member(ctx);
    return (await this.#inbox.list(ctx.tenantId, 200)).filter(
      (item) =>
        item.recipientRoles.some((role) => membership.roles.includes(role)) &&
        membershipCoversFacility(membership, item.facilityId),
    );
  }

  async #staffDeliveries(membership: TenantMembership): Promise<OutboxListEntry[]> {
    // Only staff notifications: the Case-event outbox topic is not shown.
    return (await this.#outbox.list(membership.tenantId, 200, STAFF_NOTIFICATION_TOPIC)).filter((entry) => {
      const payload = entry.payload as Partial<StaffNotificationPayload>;
      return membershipCoversFacility(membership, payload.facilityId ?? null);
    });
  }

  async #deliveryProblems(membership: TenantMembership, facilityId?: string): Promise<{ failed: number; deadLetter: number }> {
    const entries = (await this.#staffDeliveries(membership)).filter((entry) =>
      !facilityId || (entry.payload as Partial<StaffNotificationPayload>).facilityId === facilityId,
    );
    return {
      failed: entries.filter((entry) => entry.status === "failed").length,
      deadLetter: entries.filter((entry) => entry.status === "dead_letter").length,
    };
  }

  async deliveryStatus(ctx: PlatformContext): Promise<OutboxListEntry[]> {
    const membership = await this.#memberWith(ctx, "run_escalation", "settings_forbidden");
    return this.#staffDeliveries(membership);
  }

  async runEscalations(ctx: PlatformContext): Promise<EscalationRunResult> {
    await this.#memberWith(ctx, "run_escalation", "settings_forbidden");
    return this.runEscalationsForTenant(ctx.tenantId);
  }

  /** Scheduler entry point (no principal; runs as the system). */
  async runEscalationsForTenant(tenantId: string): Promise<EscalationRunResult> {
    const now = this.#now();
    const settingsList = await this.#settings.list(tenantId);
    const settingsById = new Map(settingsList.map((settings) => [settings.facilityId, settings]));
    const cases: StoredCase[] = [];
    for (let offset = 0; ; offset += SCAN_PAGE) {
      const page = await this.#search({
        tenantId, facilityScope: null, visibleToActor: null, statuses: OPEN_STATUSES,
        sort: "createdAt", order: "asc", limit: SCAN_PAGE, offset,
      });
      cases.push(...page.cases);
      if (offset + SCAN_PAGE >= page.total) break;
    }
    let enqueued = 0;
    let suppressed = 0;
    const count = (created: boolean) => { created ? (enqueued += 1) : (suppressed += 1); };
    const isAvailable = await this.#availabilityFor(tenantId, cases);
    const nowMs = Date.parse(now);

    for (const stored of cases) {
      const aggregate = stored.aggregate;
      const facilityId = aggregate.facilityId ?? null;
      const settings = facilityId ? settingsById.get(facilityId) : undefined;
      const rules = effectiveEscalationRules(settings?.escalationRules);
      const rule = (trigger: string) => rules.find((item) => item.trigger === trigger && item.enabled);

      // 1. critical and still unacknowledged (re-notified while it stays so)
      if (aggregate.priority === "critical" && aggregate.status === "NEW") {
        const critical = rule("critical_unacknowledged");
        if (critical) {
          const repeat = escalationRepeatIndex(critical, nowMs - Date.parse(aggregate.createdAt));
          count(await this.#enqueueNotification(aggregate, {
            kind: "critical_unacknowledged",
            deliveryKey: repeat === 0 ? `critical:${aggregate.id}` : `critical:${aggregate.id}:r${repeat}`,
            recipientRoles: critical.notifyRoles,
            message: repeat === 0 ? criticalMessage(aggregate.id) : `重大(critical)のCase ${aggregate.id} が未確認のままです（再通知 ${repeat} 回目）。職員による確認が必要です。`,
            stage: "critical_unacknowledged",
          }));
        }
      }

      // 2. internal response targets exceeded
      const sla = evaluateCaseSla(aggregate, stored.events, settings?.sla ?? this.#fallbackSla, now);
      for (const checkpoint of sla.checkpoints) {
        if (checkpoint.state !== "breached" || checkpoint.completedAt !== null) continue;
        const matched = rule(checkpoint.stage);
        if (!matched) continue;
        const repeat = escalationRepeatIndex(matched, checkpoint.overdueMs);
        // One notification per breach episode of a stage, plus bounded
        // re-notifications while nobody has acted. Messages are stable per
        // key so that re-evaluation yields an identical payload.
        const key = `sla:${aggregate.id}:${checkpoint.stage}:${checkpoint.startedAt}`;
        count(await this.#enqueueNotification(aggregate, {
          kind: "sla_breach",
          deliveryKey: repeat === 0 ? key : `${key}:r${repeat}`,
          recipientRoles: matched.notifyRoles,
          message: repeat === 0
            ? `Case ${aggregate.id} が内部対応期限（${checkpoint.stage}、期限 ${checkpoint.dueAt}）を超過しました。`
            : `Case ${aggregate.id} が内部対応期限（${checkpoint.stage}、期限 ${checkpoint.dueAt}）を超過したまま対応されていません（再通知 ${repeat} 回目）。`,
          stage: checkpoint.stage,
        }));
      }

      // 3. the accountable person can no longer act (left / moved facility)
      const unavailable = rule("assignee_unavailable");
      if (unavailable) {
        if (aggregate.assigneeId && !isAvailable(aggregate.assigneeId, facilityId)) {
          count(await this.#enqueueNotification(aggregate, {
            kind: "assignee_unavailable",
            deliveryKey: `unavailable:${aggregate.id}:assignee:${aggregate.assigneeId}`,
            recipientRoles: unavailable.notifyRoles,
            message: `Case ${aggregate.id} の担当者が対応できない状態です（無効化または施設外）。担当変更が必要です。`,
            stage: "assignee_unavailable",
          }));
        }
        if (aggregate.handoffTargetId && !isAvailable(aggregate.handoffTargetId, facilityId)) {
          count(await this.#enqueueNotification(aggregate, {
            kind: "assignee_unavailable",
            deliveryKey: `unavailable:${aggregate.id}:target:${aggregate.handoffTargetId}`,
            recipientRoles: unavailable.notifyRoles,
            message: `Case ${aggregate.id} の引継ぎ先が対応できない状態です（無効化または施設外）。引継ぎ先の変更が必要です。`,
            stage: "assignee_unavailable",
          }));
        }
      }
    }

    return {
      evaluatedCases: cases.length,
      enqueued,
      suppressedDuplicates: suppressed,
      delivery: await this.#deliverPending(tenantId),
    };
  }

  async #enqueueCritical(aggregate: CaseAggregate): Promise<void> {
    const settings = aggregate.facilityId ? await this.#settings.get(aggregate.tenantId, aggregate.facilityId) : null;
    const rule = effectiveEscalationRules(settings?.escalationRules).find((item) => item.trigger === "critical_unacknowledged" && item.enabled);
    if (!rule) return;
    await this.#enqueueNotification(aggregate, {
      kind: "critical_unacknowledged",
      deliveryKey: `critical:${aggregate.id}`,
      recipientRoles: rule.notifyRoles,
      message: criticalMessage(aggregate.id),
      stage: "critical_unacknowledged",
    });
    await this.#deliverPending(aggregate.tenantId);
  }

  async #enqueueNotification(
    aggregate: CaseAggregate,
    input: {
      kind: StaffNotificationPayload["kind"];
      deliveryKey: string;
      recipientRoles: StaffRole[];
      message: string;
      stage?: StaffNotificationPayload["stage"];
    },
  ): Promise<boolean> {
    const payload: StaffNotificationPayload = {
      kind: input.kind,
      caseId: aggregate.id,
      facilityId: aggregate.facilityId ?? null,
      recipientRoles: [...input.recipientRoles],
      message: input.message,
      priority: aggregate.priority,
      ...(input.stage ? { stage: input.stage } : {}),
    };
    // Storage failures propagate: they must not be reported as suppressed.
    const result = await this.#outbox.enqueue({
      tenantId: aggregate.tenantId,
      topic: STAFF_NOTIFICATION_TOPIC,
      deliveryKey: input.deliveryKey,
      payload,
      maxAttempts: 5,
    });
    return result.created;
  }

  async #deliverNotification(tenantId: string, outboxId: number, payload: unknown): Promise<void> {
    const data = payload as StaffNotificationPayload;
    const notification: StaffNotification = {
      id: `ntf-${tenantId}-${outboxId}`,
      tenantId,
      facilityId: data.facilityId,
      deliveryKey: `outbox:${outboxId}`,
      recipientRoles: data.recipientRoles,
      kind: data.kind,
      caseId: data.caseId,
      message: data.message,
      createdAt: this.#now(),
    };
    for (const channel of this.#channels) {
      await channel.deliver(notification);
    }
  }

  async #deliverPending(tenantId: string): Promise<OutboxRunResult> {
    return this.#worker.runOnce({ tenantId, workerId: "careops-notifier", limit: 50, leaseSeconds: 30 });
  }

  /** Retry loop entry point for the scheduler. */
  async deliverNotifications(tenantId: string): Promise<OutboxRunResult> {
    return this.#deliverPending(tenantId);
  }

  /* -------------------------------- AI ------------------------------ */

  async requestAiDraft(ctx: PlatformContext, caseId: string, kind: AiDraftKind): Promise<AiDraft> {
    const membership = await this.#memberWith(ctx, "request_ai_draft");
    const stored = await this.caseService.get({ tenantId: ctx.tenantId, caseId, principalId: ctx.principalId });
    if (!stored) throw new CaseNotFoundError(ctx.tenantId, caseId);

    const sources = await this.#aiSources(stored);
    const draft: AiDraft = {
      id: `draft-${this.#newId()}`,
      tenantId: ctx.tenantId,
      facilityId: stored.aggregate.facilityId ?? null,
      caseId,
      kind,
      status: "pending_review",
      provider: this.#ai.name,
      model: this.#ai.model,
      generatedAt: this.#now(),
      requestedBy: membership.actorId,
      caseVersionAtGeneration: stored.aggregate.version,
      sources: sources.map((source) => ({ ref: source.ref, label: source.label })),
      content: null,
      error: null,
      reviewedBy: null,
      reviewedAt: null,
      reviewNote: null,
      appliedEventSequence: null,
    };

    try {
      const output = await generateWithTimeout(this.#ai, { kind, aggregate: stored.aggregate, sources }, this.#aiTimeoutMs);
      draft.content = finalizeDraftContent(output, sources);
    } catch (error) {
      // AI failure never blocks Case work; it only yields a failed draft.
      draft.status = "failed";
      draft.error = error instanceof Error && error.name === "AiProviderUnavailableError"
        ? "AI支援は現在利用できません（未設定または停止中）"
        : "AI下書きの生成に失敗しました";
    }
    await this.#drafts.insert(draft);
    await this.#recordAudit({
      tenantId: ctx.tenantId,
      facilityId: draft.facilityId,
      actorId: membership.actorId,
      action: draft.status === "failed" ? "ai_draft.failed" : "ai_draft.generated",
      targetType: "ai_draft",
      targetId: draft.id,
      before: null,
      after: { caseId, kind, status: draft.status, provider: draft.provider, model: draft.model },
      reason: draft.error,
    });
    return draft;
  }

  async #aiSources(stored: StoredCase): Promise<AiSourceText[]> {
    const sources: AiSourceText[] = [];
    for (const signal of await this.#signals.list(stored.aggregate.tenantId, { caseId: stored.aggregate.id })) {
      if (signal.rawText) sources.push({ ref: `signal:${signal.id}`, label: `通知原文(${signal.sourceType})`, text: signal.rawText });
    }
    for (const event of stored.events) {
      if (event.type === "note_added" && !event.data.origin) {
        sources.push({ ref: `event:${event.sequence}`, label: `対応履歴#${event.sequence}`, text: event.data.text });
      }
      if (event.type === "handoff_requested" && event.data.note) {
        sources.push({ ref: `event:${event.sequence}`, label: `申し送り#${event.sequence}`, text: event.data.note });
      }
      if (event.type === "completed") {
        sources.push({ ref: `event:${event.sequence}`, label: `完了記録#${event.sequence}`, text: event.data.summary });
      }
    }
    return sources;
  }

  async reviewAiDraft(ctx: PlatformContext, caseId: string, draftId: string, input: AiReviewInput) {
    const membership = await this.#memberWith(ctx, "review_ai_draft", "ai_review_forbidden");
    // Re-check Case visibility for the reviewer.
    const stored = await this.caseService.get({ tenantId: ctx.tenantId, caseId, principalId: ctx.principalId });
    if (!stored) throw new CaseNotFoundError(ctx.tenantId, caseId);
    const draft = await this.#drafts.get(ctx.tenantId, draftId);
    if (!draft || draft.caseId !== caseId) throw new CareOpsNotFoundError("ai_draft");
    if (draft.status !== "pending_review" || !draft.content) {
      throw new CareOpsConflictError(`Draft is ${draft.status}`);
    }

    const reviewNote = optionalText(input.note, 1000) ?? null;
    if (input.decision === "reject") {
      const rejected: AiDraft = { ...draft, status: "rejected", reviewedBy: membership.actorId, reviewedAt: this.#now(), reviewNote };
      if (!(await this.#drafts.update(rejected, "pending_review"))) throw new CareOpsConflictError("Draft was reviewed concurrently");
      await this.#recordAudit({
        tenantId: ctx.tenantId, facilityId: draft.facilityId, actorId: membership.actorId,
        action: "ai_draft.rejected", targetType: "ai_draft", targetId: draft.id,
        before: { status: "pending_review" }, after: { status: "rejected" }, reason: reviewNote,
      });
      return { draft: rejected, operation: null };
    }

    if (draft.content.facts.some((fact) => !fact.verified) && !input.acknowledgeUnverified) {
      throw new CareOpsRuleError(
        "UNVERIFIED_FACTS_REQUIRE_ACK",
        "Draft contains facts not found in the source; explicit reviewer acknowledgement is required",
      );
    }
    const text = requireText(input.text ?? draft.content.text, "text", NOTE_TEXT_MAX);

    // Claim the draft first so two reviewers cannot both apply it.
    const claimed: AiDraft = { ...draft, status: "approved", reviewedBy: membership.actorId, reviewedAt: this.#now(), reviewNote };
    if (!(await this.#drafts.update(claimed, "pending_review"))) throw new CareOpsConflictError("Draft was reviewed concurrently");

    let operation: CaseOperationResult;
    try {
      operation = await this.caseService.execute({
        tenantId: ctx.tenantId,
        caseId,
        principalId: ctx.principalId,
        expectedVersion: input.expectedVersion,
        command: {
          type: "add_note",
          kind: "other",
          text,
          origin: { type: "ai_draft", draftId: draft.id, provider: draft.provider, model: draft.model, generatedAt: draft.generatedAt },
        },
      });
    } catch (error) {
      await this.#drafts.update({ ...draft }, "approved");
      throw error;
    }

    const applied: AiDraft = { ...claimed, appliedEventSequence: operation.event.sequence };
    await this.#drafts.update(applied, "approved");
    await this.#recordAudit({
      tenantId: ctx.tenantId, facilityId: draft.facilityId, actorId: membership.actorId,
      action: "ai_draft.approved", targetType: "ai_draft", targetId: draft.id,
      before: { status: "pending_review" },
      after: { status: "approved", appliedEventSequence: operation.event.sequence, edited: text !== draft.content.text },
      reason: reviewNote,
    });
    return { draft: applied, operation };
  }
}
