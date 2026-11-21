import type { CaseService } from "../application/case-service.ts";
import type { TenantMembership, TenantMembershipDirectory } from "../access/types.ts";
import { CASE_PRIORITIES, type CaseAggregate, type CasePriority } from "../core/types.ts";
import {
  FrameworkConflictError,
  FrameworkNotFoundError,
  FrameworkValidationError,
} from "./errors.ts";
import {
  assertCanReview,
  assertCanSubmit,
  isFieldVisible,
  isPublishedHistory,
  validateEffectiveUntil,
  validateManualContent,
  type ManualContentInput,
} from "./manual-rules.ts";
import { industryPack, templateRef } from "./packs/index.ts";
import { assertFrameworkPermission, hasFrameworkPermission } from "./policy.ts";
import type { FrameworkStore, ManualVersionWrite, ManualWrite } from "./store/types.ts";
import { normalizeSearchText, searchTerms } from "./text.ts";
import {
  FRAMEWORK_SECTORS,
  type CaseManualLink,
  type FrameworkManual,
  type FrameworkManualVersion,
  type FrameworkSector,
  type IndustryPack,
  type ManualSearchHit,
  type ManualStep,
  type TenantProfile,
} from "./types.ts";

export const FRAMEWORK_SOURCE_ADAPTER = "framework_manual";

const MANUAL_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SUBJECT_REF = /^[A-Za-z0-9._:-]{1,64}$/;

export interface FrameworkServiceOptions {
  store: FrameworkStore;
  memberships: TenantMembershipDirectory;
  caseService: CaseService;
  now?: () => string;
  newId?: () => string;
}

export interface ManualWithVersions {
  manual: FrameworkManual;
  versions: FrameworkManualVersion[];
}

export interface FieldManualView {
  manual: FrameworkManual;
  version: FrameworkManualVersion;
}

export interface OpenCaseFromManualInput {
  manualId: string;
  manualVersion: number;
  signalId: string;
  subjectRef: string;
  priority?: CasePriority;
}

/**
 * Orchestrates the Framework modules. Authorization uses the Care Ops tenant
 * membership; Case creation and every Case transition go through the existing
 * CaseService (no second state machine).
 */
export class FrameworkService {
  private readonly store: FrameworkStore;
  private readonly memberships: TenantMembershipDirectory;
  private readonly caseService: CaseService;
  private readonly now: () => string;
  private readonly newId: () => string;

  constructor(options: FrameworkServiceOptions) {
    this.store = options.store;
    this.memberships = options.memberships;
    this.caseService = options.caseService;
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  private membership(tenantId: string, principalId: string): Promise<TenantMembership | null> {
    return this.memberships.findByPrincipal(tenantId, principalId);
  }

  private async profileAndPack(tenantId: string): Promise<{ profile: TenantProfile; pack: IndustryPack }> {
    const profile = await this.store.getTenantProfile(tenantId);
    if (!profile) throw new FrameworkNotFoundError("Tenant is not configured for the Framework");
    return { profile, pack: industryPack(profile.sector) };
  }

  private categoryLabel(pack: IndustryPack, category: string): string {
    return pack.categories.find((c) => c.id === category)?.label ?? "";
  }

  private manualWrite(pack: IndustryPack, manual: FrameworkManual): ManualWrite {
    return {
      ...manual,
      search: {
        title: normalizeSearchText(manual.title),
        tags: normalizeSearchText([...manual.tags, this.categoryLabel(pack, manual.category)].join(" ")),
      },
    };
  }

  private versionWrite(version: FrameworkManualVersion): ManualVersionWrite {
    return {
      ...version,
      search: {
        summary: normalizeSearchText(version.summary),
        steps: normalizeSearchText(version.steps.map((s) => s.text).join(" ")),
      },
    };
  }

  // ── Tenant profile & Industry Packs ───────────────────────────────

  async profile(principalId: string, tenantId: string) {
    assertFrameworkPermission(await this.membership(tenantId, principalId), "read_manuals");
    const { profile, pack } = await this.profileAndPack(tenantId);
    return {
      profile,
      pack: {
        sector: pack.sector,
        version: pack.version,
        label: pack.label,
        vocabulary: pack.vocabulary,
        categories: pack.categories,
        disclaimer: pack.disclaimer,
      },
    };
  }

  async configureTenant(principalId: string, tenantId: string, input: { sector: unknown; displayName: unknown }) {
    const membership = await this.membership(tenantId, principalId);
    assertFrameworkPermission(membership, "configure_tenant");
    if (!(FRAMEWORK_SECTORS as readonly unknown[]).includes(input.sector)) {
      throw new FrameworkValidationError("sector is not supported");
    }
    if (typeof input.displayName !== "string" || !input.displayName.trim() || input.displayName.trim().length > 80) {
      throw new FrameworkValidationError("displayName must be 1-80 characters");
    }
    const sector = input.sector as FrameworkSector;
    const profile: TenantProfile = {
      tenantId,
      sector,
      packVersion: industryPack(sector).version,
      displayName: input.displayName.trim(),
      updatedBy: membership.actorId,
      updatedAt: this.now(),
    };
    await this.store.putTenantProfile(profile);
    return profile;
  }

  /**
   * Installs the tenant's Industry Pack templates as DRAFT manuals. Fictional
   * templates never reach field staff until a supervisor submits and another
   * supervisor approves them. Idempotent per template.
   */
  async installPackTemplates(principalId: string, tenantId: string) {
    const membership = await this.membership(tenantId, principalId);
    assertFrameworkPermission(membership, "manage_manuals");
    const { pack } = await this.profileAndPack(tenantId);
    const existing = new Set((await this.store.listManuals(tenantId)).map((m) => m.templateRef));
    const installed: string[] = [];
    for (const template of pack.manuals) {
      const ref = templateRef(pack, template.key);
      if (existing.has(ref)) continue;
      const at = this.now();
      const manual: FrameworkManual = {
        tenantId,
        manualId: `${pack.id}-${template.key}`,
        sector: pack.sector,
        category: template.category,
        title: template.title,
        tags: [...template.tags],
        templateRef: ref,
        createdBy: membership.actorId,
        createdAt: at,
      };
      const version: FrameworkManualVersion = {
        tenantId,
        manualId: manual.manualId,
        version: 1,
        status: "draft",
        summary: template.summary,
        steps: template.steps.map((s) => ({ ...s })),
        defaultPriority: template.defaultPriority,
        changeNote: `${pack.label} 業種別テンプレート（架空のデモ）から作成`,
        fictionalTemplate: true,
        createdBy: membership.actorId,
        createdAt: at,
        submittedAt: null,
        reviewedBy: null,
        reviewedAt: null,
        effectiveFrom: null,
        effectiveUntil: null,
      };
      try {
        await this.store.createManual(this.manualWrite(pack, manual), this.versionWrite(version));
        installed.push(manual.manualId);
      } catch (error) {
        if (!(error instanceof FrameworkConflictError && error.reason === "manual_exists")) throw error;
      }
    }
    return { installed };
  }

  // ── Manual Engine (authoring & governance) ───────────────────────

  async createManual(principalId: string, tenantId: string, input: unknown) {
    const membership = await this.membership(tenantId, principalId);
    assertFrameworkPermission(membership, "manage_manuals");
    const { pack } = await this.profileAndPack(tenantId);
    const raw = (input ?? {}) as Record<string, unknown>;
    const manualId = raw.manualId ?? `m-${this.newId()}`;
    if (typeof manualId !== "string" || !MANUAL_ID.test(manualId)) {
      throw new FrameworkValidationError("manualId must match ^[a-z0-9][a-z0-9_-]{0,63}$");
    }
    const content = validateManualContent(raw, pack.categories.map((c) => c.id));
    const at = this.now();
    const manual: FrameworkManual = {
      tenantId,
      manualId,
      sector: pack.sector,
      category: content.category,
      title: content.title,
      tags: content.tags,
      templateRef: null,
      createdBy: membership.actorId,
      createdAt: at,
    };
    const version = this.draftVersion(tenantId, manualId, 1, content, membership.actorId, at);
    await this.store.createManual(this.manualWrite(pack, manual), this.versionWrite(version));
    return { manual, version };
  }

  private draftVersion(
    tenantId: string,
    manualId: string,
    version: number,
    content: Pick<ManualContentInput, "summary" | "steps" | "defaultPriority" | "changeNote">,
    actorId: string,
    at: string,
  ): FrameworkManualVersion {
    return {
      tenantId,
      manualId,
      version,
      status: "draft",
      summary: content.summary,
      steps: content.steps,
      defaultPriority: content.defaultPriority,
      changeNote: content.changeNote,
      fictionalTemplate: false,
      createdBy: actorId,
      createdAt: at,
      submittedAt: null,
      reviewedBy: null,
      reviewedAt: null,
      effectiveFrom: null,
      effectiveUntil: null,
    };
  }

  /** New draft revision. Edited content is no longer an unmodified fictional template. */
  async reviseManual(principalId: string, tenantId: string, manualId: string, input: unknown) {
    const membership = await this.membership(tenantId, principalId);
    assertFrameworkPermission(membership, "manage_manuals");
    const manual = await this.store.getManual(tenantId, manualId);
    if (!manual) throw new FrameworkNotFoundError("Manual not found");
    const { pack } = await this.profileAndPack(tenantId);
    const content = validateManualContent(
      { ...(input as Record<string, unknown>), category: manual.category, title: manual.title, tags: manual.tags },
      pack.categories.map((c) => c.id),
    );
    const versions = await this.store.listVersions(tenantId, manualId);
    const next = (versions.at(-1)?.version ?? 0) + 1;
    const version = this.draftVersion(tenantId, manualId, next, content, membership.actorId, this.now());
    await this.store.addVersion(this.versionWrite(version));
    return version;
  }

  async submitVersion(principalId: string, tenantId: string, manualId: string, versionNumber: number) {
    const membership = await this.membership(tenantId, principalId);
    assertFrameworkPermission(membership, "manage_manuals");
    const version = await this.requireVersion(tenantId, manualId, versionNumber);
    assertCanSubmit(version, membership.actorId);
    await this.store.transitionVersion({
      tenantId, manualId, version: versionNumber, from: "draft", to: "in_review", actorId: membership.actorId, at: this.now(),
    });
    return this.requireVersion(tenantId, manualId, versionNumber);
  }

  /** Four-eyes approval: the reviewer must be a different supervisor than the author. */
  async reviewVersion(
    principalId: string,
    tenantId: string,
    manualId: string,
    versionNumber: number,
    decision: { approve: unknown; effectiveUntil?: unknown },
  ) {
    const membership = await this.membership(tenantId, principalId);
    assertFrameworkPermission(membership, "manage_manuals");
    if (typeof decision.approve !== "boolean") throw new FrameworkValidationError("approve must be a boolean");
    const version = await this.requireVersion(tenantId, manualId, versionNumber);
    assertCanReview(version, membership.actorId);
    const at = this.now();
    await this.store.transitionVersion({
      tenantId,
      manualId,
      version: versionNumber,
      from: "in_review",
      to: decision.approve ? "approved" : "rejected",
      actorId: membership.actorId,
      at,
      effectiveUntil: decision.approve ? validateEffectiveUntil(decision.effectiveUntil, at) : null,
    });
    return this.requireVersion(tenantId, manualId, versionNumber);
  }

  async retireVersion(principalId: string, tenantId: string, manualId: string, versionNumber: number) {
    const membership = await this.membership(tenantId, principalId);
    assertFrameworkPermission(membership, "manage_manuals");
    await this.requireVersion(tenantId, manualId, versionNumber);
    await this.store.transitionVersion({
      tenantId, manualId, version: versionNumber, from: "approved", to: "retired", actorId: membership.actorId, at: this.now(),
    });
    return this.requireVersion(tenantId, manualId, versionNumber);
  }

  private async requireVersion(tenantId: string, manualId: string, version: number) {
    if (!Number.isInteger(version) || version < 1) throw new FrameworkValidationError("version must be a positive integer");
    const found = await this.store.getVersion(tenantId, manualId, version);
    if (!found) throw new FrameworkNotFoundError("Manual version not found");
    return found;
  }

  async listManualsForAuthoring(principalId: string, tenantId: string): Promise<ManualWithVersions[]> {
    const membership = await this.membership(tenantId, principalId);
    if (!hasFrameworkPermission(membership, "manage_manuals") && !hasFrameworkPermission(membership, "view_training_records")) {
      assertFrameworkPermission(membership, "manage_manuals");
    }
    const manuals = await this.store.listManuals(tenantId);
    return Promise.all(manuals.map(async (manual) => ({
      manual,
      versions: await this.store.listVersions(tenantId, manual.manualId),
    })));
  }

  // ── Search Engine & field view ───────────────────────────────────

  async search(
    principalId: string,
    tenantId: string,
    query: { text?: unknown; category?: unknown; limit?: unknown },
  ): Promise<ManualSearchHit[]> {
    assertFrameworkPermission(await this.membership(tenantId, principalId), "read_manuals");
    if (query.text !== undefined && typeof query.text !== "string") throw new FrameworkValidationError("q must be a string");
    if (typeof query.text === "string" && query.text.length > 200) throw new FrameworkValidationError("q is too long");
    const category = query.category === undefined || query.category === null || query.category === "" ? null : query.category;
    if (category !== null && (typeof category !== "string" || category.length > 40)) {
      throw new FrameworkValidationError("category is invalid");
    }
    const limit = query.limit === undefined ? 20 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new FrameworkValidationError("limit must be 1-50");
    return this.store.searchFieldManuals(
      tenantId,
      { terms: searchTerms((query.text as string | undefined) ?? ""), category, limit },
      this.now(),
    );
  }

  /** The current approved, effective version — the only content shown as a standard procedure. */
  async fieldManual(principalId: string, tenantId: string, manualId: string): Promise<FieldManualView> {
    assertFrameworkPermission(await this.membership(tenantId, principalId), "read_manuals");
    const manual = await this.store.getManual(tenantId, manualId);
    if (!manual) throw new FrameworkNotFoundError("Manual not found");
    const now = this.now();
    const version = (await this.store.listVersions(tenantId, manualId)).find((v) => isFieldVisible(v, now));
    if (!version) throw new FrameworkNotFoundError("No approved, effective version");
    return { manual, version };
  }

  /** A specific version for evidence tracing. Drafts are visible to manual managers only. */
  async manualVersion(principalId: string, tenantId: string, manualId: string, versionNumber: number) {
    const membership = await this.membership(tenantId, principalId);
    assertFrameworkPermission(membership, "read_manuals");
    const manual = await this.store.getManual(tenantId, manualId);
    const version = await this.store.getVersion(tenantId, manualId, versionNumber);
    if (!manual || !version) throw new FrameworkNotFoundError("Manual version not found");
    if (!isPublishedHistory(version) && !hasFrameworkPermission(membership, "manage_manuals")) {
      throw new FrameworkNotFoundError("Manual version not found");
    }
    return { manual, version, fieldVisible: isFieldVisible(version, this.now()) };
  }

  // ── Response Engine: Manual → Case ───────────────────────────────

  /**
   * Opens a Case from the approved manual version the staff member was looking at.
   * - membership + reporting role (ADR 0019 rule) checked before any write
   * - the pinned version must still be the field-visible one (else 409 stale)
   * - Case creation uses CaseService.openFromSignal (Signal idempotency: a retry with
   *   the same signalId returns the original Case)
   * - the manual version link is append-only and idempotent; a failed link write is
   *   reported as an error and repaired by retrying with the same signalId
   */
  async openCaseFromManual(principalId: string, tenantId: string, input: OpenCaseFromManualInput): Promise<{
    aggregate: CaseAggregate;
    created: boolean;
    link: CaseManualLink;
  }> {
    const membership = await this.membership(tenantId, principalId);
    assertFrameworkPermission(membership, "open_case");
    if (typeof input.signalId !== "string" || !SAFE_ID.test(input.signalId)) {
      throw new FrameworkValidationError("signalId must be a safe identifier");
    }
    if (typeof input.subjectRef !== "string" || !SUBJECT_REF.test(input.subjectRef)) {
      throw new FrameworkValidationError("subjectRef must be a pseudonymous key matching ^[A-Za-z0-9._:-]{1,64}$");
    }
    if (input.priority !== undefined && !(CASE_PRIORITIES as readonly string[]).includes(input.priority)) {
      throw new FrameworkValidationError("priority is not supported");
    }
    const version = await this.requireVersion(tenantId, input.manualId, input.manualVersion);

    const signal = (priority: CasePriority) => ({
      id: input.signalId,
      tenantId,
      sourceAdapter: FRAMEWORK_SOURCE_ADAPTER,
      subjectId: input.subjectRef,
      type: "manual" as const,
      priority,
    });

    // Retry of an earlier report: the link (unique per tenant + signal) proves the Case exists,
    // so openFromSignal only replays it. Works even if the manual was revised in between.
    const prior = await this.store.getCaseLinkBySignal(tenantId, input.signalId);
    if (prior) {
      if (prior.manualId !== input.manualId || prior.manualVersion !== input.manualVersion || prior.subjectRef !== input.subjectRef) {
        throw new FrameworkConflictError("case_link_mismatch");
      }
      const replay = await this.caseService.openFromSignal(signal(input.priority ?? version.defaultPriority), `case-${this.newId()}`);
      return { aggregate: replay.aggregate, created: false, link: prior };
    }

    // New report: only from the version that is currently the approved, effective procedure.
    if (!isFieldVisible(version, this.now())) throw new FrameworkConflictError("manual_version_stale");

    const opened = await this.caseService.openFromSignal(
      signal(input.priority ?? version.defaultPriority),
      `case-${this.newId()}`,
    );
    const link: CaseManualLink = {
      tenantId,
      caseId: opened.aggregate.id,
      manualId: input.manualId,
      manualVersion: input.manualVersion,
      signalId: input.signalId,
      subjectRef: input.subjectRef,
      linkedBy: membership.actorId,
      linkedAt: this.now(),
    };
    await this.store.linkCase(link);
    return { aggregate: opened.aggregate, created: opened.created, link };
  }

  /** Manual version a Case was opened from; visible to members who may read the Case. */
  async caseManual(principalId: string, tenantId: string, caseId: string) {
    const stored = await this.caseService.get({ tenantId, caseId, principalId });
    if (!stored) throw new FrameworkNotFoundError("Case not found");
    const link = await this.store.getCaseLink(tenantId, caseId);
    if (!link) return { link: null, manual: null, version: null };
    const manual = await this.store.getManual(tenantId, link.manualId);
    const version = await this.store.getVersion(tenantId, link.manualId, link.manualVersion);
    return { link, manual, version };
  }

  /** Steps of the linked manual version, for checklists in the response UI. */
  static stepIds(version: FrameworkManualVersion | null): ManualStep[] {
    return version ? version.steps : [];
  }
}
