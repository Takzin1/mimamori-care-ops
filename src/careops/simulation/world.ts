import { MutableTenantMembershipDirectory } from "../../access/mutable-membership-directory.ts";
import type { StaffRole, TenantMembership } from "../../access/types.ts";
import type { CaseCommandIntent } from "../../application/types.ts";
import type { CaseAggregate } from "../../core/types.ts";
import { InMemoryCaseRepository } from "../../persistence/in-memory-case-repository.ts";
import {
  AiProviderUnavailableError,
  RuleBasedDraftProvider,
  type AiDraftProvider,
} from "../ai-assist.ts";
import { defaultFacilitySettings } from "../defaults.ts";
import {
  InMemoryAiDraftStore,
  InMemoryAuditLogStore,
  InMemoryFacilitySettingsStore,
  InMemoryOutboxStore,
  InMemorySignalStore,
  InMemoryStaffNotificationInbox,
} from "../in-memory-stores.ts";
import type { LocalCareOpsStores } from "../local.ts";
import {
  CareOpsPlatformService,
  type ManualCaseInput,
  type PlatformContext,
  type SignalIntakeInput,
} from "../platform-service.ts";
import type { CaseListFilter } from "../projections.ts";
import type { AiDraftKind, StaffNotification, StaffNotificationChannel } from "../types.ts";

/**
 * Simulation Lab world: a fresh, isolated CareOps instance with SYNTHETIC
 * staff, facilities and residents, a virtual clock, a membership
 * directory that can change (departure, transfer), and an external
 * notification channel that can be made to fail.
 *
 * Everything runs through the real CareOpsPlatformService — the same
 * authorization, state machine, escalation and persistence contracts as
 * the product. Nothing here touches a real store unless one is injected.
 */

export const SIM_TENANT = "sim-tenant";
export const SIM_OTHER_TENANT = "sim-other-tenant";
export const SIM_FACILITIES = { sakura: "sim-sakura", kaede: "sim-kaede", other: "sim-other-home" } as const;

export interface SimStaff {
  key: string;
  principalId: string;
  actorId: string;
  tenantId: string;
  roles: StaffRole[];
  facilityIds: string[] | null;
  label: string;
}

export const SIM_STAFF: readonly SimStaff[] = [
  { key: "desk", principalId: "sim-p-desk", actorId: "sim-desk", tenantId: SIM_TENANT, roles: ["dispatcher"], facilityIds: [SIM_FACILITIES.sakura], label: "さくら館 受付" },
  { key: "nightDesk", principalId: "sim-p-night", actorId: "sim-night-desk", tenantId: SIM_TENANT, roles: ["dispatcher"], facilityIds: [SIM_FACILITIES.sakura], label: "さくら館 夜勤受付" },
  { key: "r1", principalId: "sim-p-r1", actorId: "sim-r1", tenantId: SIM_TENANT, roles: ["responder"], facilityIds: [SIM_FACILITIES.sakura], label: "さくら館 介護職員1" },
  { key: "r2", principalId: "sim-p-r2", actorId: "sim-r2", tenantId: SIM_TENANT, roles: ["responder"], facilityIds: [SIM_FACILITIES.sakura], label: "さくら館 介護職員2" },
  { key: "r3", principalId: "sim-p-r3", actorId: "sim-r3", tenantId: SIM_TENANT, roles: ["responder"], facilityIds: [SIM_FACILITIES.sakura], label: "さくら館 介護職員3" },
  { key: "lead", principalId: "sim-p-lead", actorId: "sim-lead", tenantId: SIM_TENANT, roles: ["supervisor"], facilityIds: [SIM_FACILITIES.sakura], label: "さくら館 管理者" },
  { key: "kaedeDesk", principalId: "sim-p-kdesk", actorId: "sim-kaede-desk", tenantId: SIM_TENANT, roles: ["dispatcher"], facilityIds: [SIM_FACILITIES.kaede], label: "かえで館 受付" },
  { key: "kaedeR", principalId: "sim-p-kr", actorId: "sim-kaede-r1", tenantId: SIM_TENANT, roles: ["responder"], facilityIds: [SIM_FACILITIES.kaede], label: "かえで館 介護職員" },
  { key: "kaedeLead", principalId: "sim-p-klead", actorId: "sim-kaede-lead", tenantId: SIM_TENANT, roles: ["supervisor"], facilityIds: [SIM_FACILITIES.kaede], label: "かえで館 管理者" },
  { key: "area", principalId: "sim-p-area", actorId: "sim-area", tenantId: SIM_TENANT, roles: ["supervisor"], facilityIds: null, label: "法人 エリア管理者" },
  { key: "auditor", principalId: "sim-p-aud", actorId: "sim-auditor", tenantId: SIM_TENANT, roles: ["auditor"], facilityIds: null, label: "監査担当" },
  { key: "otherLead", principalId: "sim-p-other", actorId: "sim-other-lead", tenantId: SIM_OTHER_TENANT, roles: ["supervisor"], facilityIds: null, label: "他法人 管理者" },
];

export type SimStepKind = "action" | "check" | "time" | "fault" | "note";

export interface SimStep {
  index: number;
  /** Simulated clock (JST) when the step happened. */
  at: string;
  kind: SimStepKind;
  label: string;
  ok: boolean;
  detail: string;
}

export type SimAiMode = "rules" | "unavailable" | "unverified";

export interface SimWorldOptions {
  startAt: string;
  ai?: SimAiMode;
  /**
   * Inject persistent stores (e.g. SQLite) instead of in-memory ones.
   * The factory receives the world's virtual clock so that time-based
   * stores (outbox retry) follow simulated time.
   */
  stores?: (now: () => string) => LocalCareOpsStores | Promise<LocalCareOpsStores>;
}

/** External channel stand-in whose failures are scripted by scenarios. */
export class ScriptedChannel implements StaffNotificationChannel {
  readonly name = "sim-external";
  failNext = 0;
  down = false;
  delivered: StaffNotification[] = [];
  attempts = 0;

  async deliver(notification: StaffNotification): Promise<void> {
    this.attempts += 1;
    if (this.down || this.failNext > 0) {
      if (this.failNext > 0) this.failNext -= 1;
      throw new Error("simulated channel failure");
    }
    this.delivered.push(notification);
  }
}

function aiFor(mode: SimAiMode): AiDraftProvider {
  if (mode === "rules") return new RuleBasedDraftProvider();
  if (mode === "unavailable") {
    return { name: "sim-unavailable", model: "none", async generate() { throw new AiProviderUnavailableError(); } };
  }
  return {
    name: "sim-unverified",
    model: "sim-1",
    async generate() {
      return {
        text: "（合成）原文にない内容を含む下書き",
        facts: [{ label: "体温", value: "38.5度", quote: "体温38.5度", sourceRef: "signal:does-not-exist" }],
        missing: [],
        uncertain: [],
      };
    },
  };
}

const COMMAND_LABEL: Record<CaseCommandIntent["type"], string> = {
  set_priority: "優先度を変更",
  acknowledge: "確認（受付）",
  triage: "判断（トリアージ）",
  assign: "担当を割当",
  reassign: "担当を変更",
  start_action: "対応を開始",
  add_note: "対応履歴を記録",
  escalate: "エスカレーション",
  clear_escalation: "エスカレーションを解除",
  request_handoff: "引継ぎを依頼",
  accept_handoff: "引継ぎを受領",
  decline_handoff: "引継ぎを辞退",
  cancel_handoff: "引継ぎを取消",
  complete: "解決を登録",
  close: "クローズ",
  reopen: "再開",
};

const JST_OFFSET_MS = 9 * 3_600_000;

export function formatJst(iso: string): string {
  const shifted = new Date(Date.parse(iso) + JST_OFFSET_MS).toISOString();
  return `${shifted.slice(5, 10).replace("-", "/")} ${shifted.slice(11, 16)}`;
}

export class SimWorld {
  readonly platform: CareOpsPlatformService;
  readonly directory: MutableTenantMembershipDirectory;
  readonly channel = new ScriptedChannel();
  readonly stores: LocalCareOpsStores;
  readonly steps: SimStep[] = [];
  readonly #clock: { ms: number };
  #idCounter = 0;
  readonly #startMs: number;

  private constructor(options: SimWorldOptions, stores: LocalCareOpsStores, clock: { ms: number }) {
    this.#clock = clock;
    this.#startMs = clock.ms;
    this.stores = stores;
    this.directory = new MutableTenantMembershipDirectory(
      SIM_STAFF.map((staff): TenantMembership => ({
        tenantId: staff.tenantId,
        principalId: staff.principalId,
        actorId: staff.actorId,
        roles: [...staff.roles],
        active: true,
        ...(staff.facilityIds ? { facilityIds: [...staff.facilityIds] } : {}),
      })),
    );
    this.platform = new CareOpsPlatformService({
      ...stores,
      memberships: this.directory,
      channels: [this.channel],
      ai: aiFor(options.ai ?? "rules"),
      now: this.now,
      newId: () => `sim${String(++this.#idCounter).padStart(4, "0")}`,
      notificationRetryDelayMs: 60_000,
    });
  }

  static async create(options: SimWorldOptions): Promise<SimWorld> {
    const startAt = options.startAt;
    const clock = { ms: Date.parse(startAt) };
    if (!Number.isFinite(clock.ms)) throw new Error("invalid scenario start time");
    const now = () => new Date(clock.ms).toISOString();
    const stores: LocalCareOpsStores = options.stores ? await options.stores(now) : {
      repository: new InMemoryCaseRepository(),
      signals: new InMemorySignalStore(),
      settings: new InMemoryFacilitySettingsStore(),
      audit: new InMemoryAuditLogStore(),
      drafts: new InMemoryAiDraftStore(),
      outbox: new InMemoryOutboxStore(now),
      inbox: new InMemoryStaffNotificationInbox(),
    };
    const world = new SimWorld(options, stores, clock);
    for (const [tenantId, facilityId, displayName] of [
      [SIM_TENANT, SIM_FACILITIES.sakura, "さくら館（合成）"],
      [SIM_TENANT, SIM_FACILITIES.kaede, "かえで館（合成）"],
      [SIM_OTHER_TENANT, SIM_FACILITIES.other, "他法人ホーム（合成）"],
    ] as const) {
      await stores.settings.save(defaultFacilitySettings({ tenantId, facilityId, displayName, now: startAt }), 0);
    }
    return world;
  }

  /* ------------------------------ clock ------------------------------ */

  now = (): string => new Date(this.#clock.ms).toISOString();

  get elapsedMinutes(): number {
    return Math.round((this.#clock.ms - this.#startMs) / 60_000);
  }

  advance(minutes: number, why = ""): void {
    this.#clock.ms += minutes * 60_000;
    this.#record("time", `${minutes}分経過${why ? `（${why}）` : ""}`, true, `現在 ${formatJst(this.now())}`);
  }

  /* ----------------------------- recording ---------------------------- */

  #record(kind: SimStepKind, label: string, ok: boolean, detail = ""): void {
    this.steps.push({ index: this.steps.length + 1, at: formatJst(this.now()), kind, label, ok, detail: detail.slice(0, 300) });
  }

  note(text: string): void {
    this.#record("note", text, true);
  }

  expect(label: string, condition: unknown, detail: unknown = ""): void {
    this.#record("check", label, Boolean(condition), typeof detail === "string" ? detail : JSON.stringify(detail));
  }

  expectEqual(label: string, actual: unknown, expected: unknown): void {
    const same = JSON.stringify(actual) === JSON.stringify(expected);
    this.#record("check", label, same, same ? JSON.stringify(actual) : `actual ${JSON.stringify(actual)} / expected ${JSON.stringify(expected)}`);
  }

  /** The operation must be rejected (authorization, state, or conflict). */
  async expectDenied(label: string, operation: () => Promise<unknown>, errorName?: string): Promise<void> {
    try {
      await operation();
      this.#record("check", label, false, "操作が拒否されず成功してしまった");
    } catch (error) {
      const name = error instanceof Error ? error.name : "unknown";
      this.#record("check", label, !errorName || name === errorName, `拒否: ${name}`);
    }
  }

  /* ------------------------------ actors ------------------------------ */

  staff(key: string): SimStaff {
    const staff = SIM_STAFF.find((item) => item.key === key);
    if (!staff) throw new Error(`unknown sim staff: ${key}`);
    return staff;
  }

  ctx(key: string, tenantId?: string): PlatformContext {
    const staff = this.staff(key);
    return { tenantId: tenantId ?? staff.tenantId, principalId: staff.principalId };
  }

  actor(key: string): string {
    return this.staff(key).actorId;
  }

  deactivate(key: string, why = "退職"): void {
    const staff = this.staff(key);
    this.directory.update(staff.tenantId, staff.principalId, { active: false });
    this.#record("fault", `${staff.label} を無効化（${why}）`, true);
  }

  transfer(key: string, facilityId: string): void {
    const staff = this.staff(key);
    this.directory.update(staff.tenantId, staff.principalId, { facilityIds: [facilityId] });
    this.#record("fault", `${staff.label} を ${facilityId} へ異動`, true);
  }

  setRoles(key: string, roles: StaffRole[]): void {
    const staff = this.staff(key);
    this.directory.update(staff.tenantId, staff.principalId, { roles });
    this.#record("fault", `${staff.label} のロールを ${roles.join(",")} に変更`, true);
  }

  breakChannel(failures: number | "down"): void {
    if (failures === "down") this.channel.down = true;
    else this.channel.failNext = failures;
    this.#record("fault", failures === "down" ? "外部通知チャネルを停止" : `外部通知チャネルが次の${failures}回失敗`, true);
  }

  /* ----------------------------- operations --------------------------- */

  async signal(key: string, input: Omit<SignalIntakeInput, "facilityId"> & { facilityId?: string }) {
    const result = await this.platform.ingestSignal(this.ctx(key), { facilityId: SIM_FACILITIES.sakura, ...input });
    this.#record("action", `${this.staff(key).label}: 通知を記録（${input.sourceType} / ${input.sourceSignalId}）`, true, `結果 ${result.outcome}${result.caseId ? ` → ${result.caseId}` : ""}`);
    return result;
  }

  async adapterSignal(input: Omit<SignalIntakeInput, "facilityId"> & { facilityId?: string }) {
    const result = await this.platform.ingestFromAdapter(SIM_TENANT, { facilityId: SIM_FACILITIES.sakura, ...input });
    this.#record("action", `アダプタ: 通知を受信（${input.sourceType} / ${input.sourceSignalId}）`, true, `結果 ${result.outcome}${result.caseId ? ` → ${result.caseId}` : ""}`);
    return result;
  }

  async createCase(key: string, input: Partial<ManualCaseInput> & { subjectId: string }): Promise<CaseAggregate> {
    const result = await this.platform.createCase(this.ctx(key), {
      facilityId: SIM_FACILITIES.sakura,
      sourceType: "manual",
      priority: "normal",
      priorityRationale: "合成シナリオ",
      rawText: "（合成）職員が受けた通知",
      ...input,
    });
    this.#record("action", `${this.staff(key).label}: Caseを作成（優先度 ${result.aggregate.priority}）`, true, result.aggregate.id);
    return result.aggregate;
  }

  async caseFromSignal(key: string, signalId: string, input: { priority: CaseAggregate["priority"]; category?: string; priorityRationale?: string }): Promise<CaseAggregate> {
    const result = await this.platform.createCaseFromSignal(this.ctx(key), signalId, { priorityRationale: "合成シナリオ", ...input });
    this.#record("action", `${this.staff(key).label}: 通知からCaseを作成`, true, result.aggregate.id);
    return result.aggregate;
  }

  async current(caseId: string, tenantId = SIM_TENANT): Promise<CaseAggregate> {
    const stored = await this.stores.repository.load(tenantId, caseId);
    if (!stored) throw new Error(`case not found: ${caseId}`);
    return stored.aggregate;
  }

  /** Executes a command at the Case's current version (as the UI would). */
  async cmd(key: string, caseId: string, command: CaseCommandIntent): Promise<CaseAggregate> {
    const version = (await this.current(caseId)).version;
    const result = await this.platform.execute(this.ctx(key), caseId, version, command);
    this.#record("action", `${this.staff(key).label}: ${COMMAND_LABEL[command.type]}`, true, `→ ${result.aggregate.status}${result.aggregate.assigneeId ? ` / 担当 ${result.aggregate.assigneeId}` : ""}`);
    return result.aggregate;
  }

  /** Executes with an explicit (possibly stale) version. */
  async cmdAt(key: string, caseId: string, version: number, command: CaseCommandIntent): Promise<CaseAggregate> {
    return (await this.platform.execute(this.ctx(key), caseId, version, command)).aggregate;
  }

  async escalate() {
    const result = await this.platform.runEscalationsForTenant(SIM_TENANT);
    this.#record("action", "期限チェックを実行", true, `新規通知 ${result.enqueued} / 重複抑止 ${result.suppressedDuplicates} / 配信 ${result.delivery.delivered} / 失敗 ${result.delivery.failed}`);
    return result;
  }

  async deliver() {
    const result = await this.platform.deliverNotifications(SIM_TENANT);
    this.#record("action", "通知の再配信を実行", true, `配信 ${result.delivered} / 失敗 ${result.failed}`);
    return result;
  }

  detail(key: string, caseId: string) {
    return this.platform.caseDetail(this.ctx(key), caseId);
  }

  dashboard(key: string, facilityId?: string) {
    return this.platform.dashboard(this.ctx(key), facilityId);
  }

  list(key: string, filter: CaseListFilter = {}) {
    return this.platform.listCases(this.ctx(key), filter);
  }

  board(key: string) {
    return this.platform.handoffBoard(this.ctx(key));
  }

  inbox(key: string) {
    return this.platform.notifications(this.ctx(key));
  }

  async draft(key: string, caseId: string, kind: AiDraftKind = "case_summary") {
    const draft = await this.platform.requestAiDraft(this.ctx(key), caseId, kind);
    this.#record("action", `${this.staff(key).label}: AI下書きを依頼（${kind}）`, true, `状態 ${draft.status}`);
    return draft;
  }

  /** Marks an unexpected exception as a failed step. */
  fail(error: unknown): void {
    this.#record("check", "シナリオが例外なく最後まで実行される", false, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  }
}
