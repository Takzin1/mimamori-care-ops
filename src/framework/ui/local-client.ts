import { CaseQueueService } from "../../application/queue-service.ts";
import { CaseService } from "../../application/case-service.ts";
import { CaseAccessDeniedError } from "../../access/errors.ts";
import { InMemoryTenantMembershipDirectory } from "../../access/in-memory-membership-directory.ts";
import type { CaseCommandIntent } from "../../application/types.ts";
import type { CasePriority } from "../../core/types.ts";
import { InMemoryTenantSlaPolicyDirectory, type CaseSlaPolicy } from "../../operations/index.ts";
import { InMemoryCaseRepository } from "../../persistence/in-memory-case-repository.ts";
import { FrameworkService } from "../framework-service.ts";
import { INDUSTRY_PACKS } from "../packs/index.ts";
import { FrameworkRecordsService } from "../records-service.ts";
import { InMemoryFrameworkStore } from "../store/in-memory-framework-store.ts";
import { FRAMEWORK_SECTORS, type FrameworkSector } from "../types.ts";
import type { CaseHistoryItem, DemoControls, FrameworkClient, Persona, ProfileView, StaffOption } from "./client.ts";

/**
 * Public demo adapter: the real Framework services, CaseService and Case queue run in
 * the browser on in-memory stores with synthetic personas. Nothing leaves the page
 * (the demo's Content-Security-Policy also blocks network access). State is lost on
 * reload by design — it is not a database.
 */
const MINUTE = 60_000;
const STAGE = { acknowledgeWithinMs: 10 * MINUTE, assignWithinMs: 10 * MINUTE, firstActionWithinMs: 15 * MINUTE, handoffAcceptWithinMs: 15 * MINUTE, completeWithinMs: 120 * MINUTE };
const DEMO_POLICY: CaseSlaPolicy = { critical: STAGE, high: STAGE, normal: STAGE, low: STAGE };

const PERSONAS: Array<Persona & { principalId: string; actorId: string; roles: ("dispatcher" | "responder" | "supervisor")[] }> = [
  { id: "staff", label: "あなた（職員）", description: "手順を見て対応を始め、担当として記録します。", principalId: "demo:staff", actorId: "demo-staff", roles: ["responder"] },
  { id: "lead", label: "責任者", description: "対応を受け付け、担当を割り当て、終了を確認します。", principalId: "demo:lead", actorId: "demo-lead", roles: ["dispatcher", "supervisor"] },
  { id: "colleague", label: "交代職員", description: "引き継ぎを受けて対応を続けます。", principalId: "demo:colleague", actorId: "demo-colleague", roles: ["responder"] },
];
const AUTHOR = { principalId: "demo:author", actorId: "demo-author" };
const REVIEWER = { principalId: "demo:reviewer", actorId: "demo-reviewer" };

function tenantOf(sector: FrameworkSector) {
  return `demo-${sector}`;
}

export class LocalDemoClient implements FrameworkClient, DemoControls {
  readonly mode = "demo" as const;
  private readonly store = new InMemoryFrameworkStore();
  private readonly repository = new InMemoryCaseRepository();
  private readonly caseService: CaseService;
  private readonly queueService: CaseQueueService;
  private readonly framework: FrameworkService;
  private readonly records: FrameworkRecordsService;
  private readonly provisioned = new Set<FrameworkSector>();
  private activeSector: FrameworkSector = "care";
  private activePersona = "staff";
  private seq = 0;
  private readonly opened = new Map<FrameworkSector, string[]>();
  private readonly clockNow: () => string;

  constructor(clockNow: () => string = () => new Date().toISOString()) {
    this.clockNow = clockNow;
    const memberships = new InMemoryTenantMembershipDirectory(
      FRAMEWORK_SECTORS.flatMap((sector) => [
        ...PERSONAS.map((p) => ({ tenantId: tenantOf(sector), principalId: p.principalId, actorId: p.actorId, roles: p.roles, active: true })),
        { tenantId: tenantOf(sector), principalId: AUTHOR.principalId, actorId: AUTHOR.actorId, roles: ["supervisor" as const], active: true },
        { tenantId: tenantOf(sector), principalId: REVIEWER.principalId, actorId: REVIEWER.actorId, roles: ["supervisor" as const], active: true },
      ]),
    );
    this.caseService = new CaseService(this.repository, memberships, this.clockNow);
    this.queueService = new CaseQueueService(
      this.repository,
      memberships,
      new InMemoryTenantSlaPolicyDirectory(Object.fromEntries(FRAMEWORK_SECTORS.map((s) => [tenantOf(s), DEMO_POLICY]))),
      this.clockNow,
    );
    this.framework = new FrameworkService({
      store: this.store,
      memberships,
      caseService: this.caseService,
      now: this.clockNow,
      newId: () => `${Date.now().toString(36)}-${(++this.seq).toString(36)}`,
    });
    this.records = new FrameworkRecordsService({ store: this.store, memberships, caseService: this.caseService, now: this.clockNow });
  }

  private get tenant() {
    return tenantOf(this.activeSector);
  }

  private get principal() {
    return PERSONAS.find((p) => p.id === this.activePersona)!.principalId;
  }

  /** Configure the sector tenant and run the template governance flow (author submits, a different reviewer approves). */
  private async ensure(sector: FrameworkSector) {
    if (this.provisioned.has(sector)) return;
    const tenant = tenantOf(sector);
    await this.framework.configureTenant(AUTHOR.principalId, tenant, { sector, displayName: `デモ${INDUSTRY_PACKS[sector].vocabulary.organizationLabel}（架空）` });
    const { installed } = await this.framework.installPackTemplates(AUTHOR.principalId, tenant);
    for (const manualId of installed) {
      await this.framework.submitVersion(AUTHOR.principalId, tenant, manualId, 1);
      await this.framework.reviewVersion(REVIEWER.principalId, tenant, manualId, 1, { approve: true });
    }
    this.provisioned.add(sector);
  }

  sectors() {
    return FRAMEWORK_SECTORS.map((sector) => ({ sector, label: INDUSTRY_PACKS[sector].label }));
  }

  sector() {
    return this.activeSector;
  }

  async setSector(sector: FrameworkSector) {
    await this.ensure(sector);
    this.activeSector = sector;
  }

  personas(): Persona[] {
    return PERSONAS.map(({ id, label, description }) => ({ id, label, description }));
  }

  persona() {
    return this.activePersona;
  }

  setPersona(id: string) {
    if (!PERSONAS.some((p) => p.id === id)) throw new Error("unknown persona");
    this.activePersona = id;
  }

  personaForActor(actorId: string | null): Persona | null {
    const p = PERSONAS.find((x) => x.actorId === actorId);
    return p ? { id: p.id, label: p.label, description: p.description } : null;
  }

  async whoAmI() {
    const p = PERSONAS.find((x) => x.id === this.activePersona)!;
    return { actorId: p.actorId, label: p.label, roles: [...p.roles] };
  }

  async profile(): Promise<ProfileView> {
    await this.ensure(this.activeSector);
    const { profile, pack } = await this.framework.profile(this.principal, this.tenant);
    return {
      sector: pack.sector,
      organizationName: profile.displayName,
      sectorLabel: pack.label,
      vocabulary: pack.vocabulary,
      categories: pack.categories,
      disclaimer: pack.disclaimer,
    };
  }

  async search(text: string, category: string | null) {
    await this.ensure(this.activeSector);
    return this.framework.search(this.principal, this.tenant, { text, category });
  }

  async manual(manualId: string) {
    return this.framework.fieldManual(this.principal, this.tenant, manualId);
  }

  async openCase(input: { manualId: string; manualVersion: number; signalId: string; subjectRef: string; priority?: CasePriority }) {
    const result = await this.framework.openCaseFromManual(this.principal, this.tenant, input);
    const list = this.opened.get(this.activeSector) ?? [];
    if (!list.includes(result.aggregate.id)) this.opened.set(this.activeSector, [result.aggregate.id, ...list]);
    return { caseId: result.aggregate.id, created: result.created };
  }

  async cases() {
    return this.queueService.list({ tenantId: this.tenant, principalId: this.principal });
  }

  async caseDetail(caseId: string) {
    const [stored, capabilities, manual, steps] = await Promise.all([
      this.caseService.get({ tenantId: this.tenant, caseId, principalId: this.principal }),
      this.caseService.capabilities({ tenantId: this.tenant, caseId, principalId: this.principal }),
      this.framework.caseManual(this.principal, this.tenant, caseId),
      this.records.listStepChecks(this.principal, this.tenant, caseId),
    ]);
    if (!stored) throw Object.assign(new Error("not found"), { code: "CASE_NOT_FOUND" });
    return {
      stored,
      capabilities,
      manual: manual.link ? { link: manual.link, manual: manual.manual, version: manual.version } : null,
      steps: steps.steps,
      checks: steps.checks,
    };
  }

  async execute(caseId: string, expectedVersion: number, command: CaseCommandIntent) {
    await this.caseService.execute({ tenantId: this.tenant, caseId, principalId: this.principal, expectedVersion, command });
  }

  async checkStep(caseId: string, stepId: string) {
    await this.records.checkStep(this.principal, this.tenant, caseId, stepId);
  }

  async evidence(caseId: string) {
    return this.records.evidence(this.principal, this.tenant, caseId);
  }

  async courses() {
    await this.ensure(this.activeSector);
    return this.records.listCourses(this.principal, this.tenant);
  }

  async course(courseId: string) {
    return this.records.courseDetail(this.principal, this.tenant, courseId);
  }

  async submitQuiz(courseId: string, attemptId: string, answers: Record<string, string>) {
    return this.records.submitQuiz(this.principal, this.tenant, courseId, { attemptId, answers });
  }

  async scenario(courseId: string, attemptId: string, answers: Array<{ stepId: string; choiceId: string }>, final: boolean) {
    return this.records.scenario(this.principal, this.tenant, courseId, { attemptId, answers, final });
  }

  async attempts() {
    return this.records.attempts(this.principal, this.tenant, "mine");
  }

  /** Cases opened in this browser session that the current persona may read (RBAC applies). */
  async caseHistory(): Promise<CaseHistoryItem[]> {
    const items: CaseHistoryItem[] = [];
    for (const caseId of this.opened.get(this.activeSector) ?? []) {
      const stored = await this.caseService.get({ tenantId: this.tenant, caseId, principalId: this.principal }).catch((error: unknown) => {
        if (error instanceof CaseAccessDeniedError) return null; // not visible to this persona
        throw error;
      });
      if (!stored) continue;
      const manual = await this.framework.caseManual(this.principal, this.tenant, caseId);
      items.push({
        caseId,
        status: stored.aggregate.status,
        subjectId: stored.aggregate.subjectId,
        createdAt: stored.aggregate.createdAt,
        manualTitle: manual.manual?.title ?? null,
      });
    }
    return items;
  }

  async staffOptions(): Promise<StaffOption[]> {
    return PERSONAS.filter((p) => p.roles.includes("responder")).map((p) => ({ actorId: p.actorId, label: p.label }));
  }

  /** Everything in this browser session, for the JSON export (synthetic only). */
  async exportAll() {
    const sector = this.activeSector;
    const lead = PERSONAS.find((p) => p.id === "lead")!.principalId;
    const queue = await this.queueService.list({ tenantId: this.tenant, principalId: lead });
    const evidence = await Promise.all(queue.items.map((item) => this.records.evidence(lead, this.tenant, item.caseId)));
    return {
      schema: "mimamori.framework.demo-export.v1",
      synthetic: true,
      notice: "架空のデモデータです。実在の人物・施設・記録ではありません。",
      exportedAt: this.clockNow(),
      sector,
      cases: evidence,
      training: await this.records.attempts(lead, this.tenant, "all"),
    };
  }
}
