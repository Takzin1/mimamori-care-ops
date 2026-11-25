import type { CaseCommandIntent } from "../../application/types.ts";
import { CareOpsHttpClient } from "../../client/care-ops-http-client.ts";
import type { AccessTokenProvider } from "../../client/types.ts";
import type { CasePriority } from "../../core/types.ts";
import type { CaseManualLink, CaseStepCheck, FrameworkManual, FrameworkManualVersion, ManualSearchHit, ManualStep, TrainingAttempt } from "../types.ts";
import {
  classifyFailure,
  FrameworkClientError,
  type CaseDetailView,
  type CourseDetailView,
  type CourseListItem,
  type FrameworkClient,
  type ProfileView,
  type QuizOutcome,
  type ScenarioOutcome,
  type StaffOption,
} from "./client.ts";

/**
 * Production adapter. Framework routes (/api/framework/...) and Care Ops routes
 * (/api/care-ops/...) are called with the same bearer token; the servers verify
 * the token, tenant membership and roles. Case transitions are executed only by
 * the Care Ops API (CaseService); this client never derives a status locally.
 * Failed writes are surfaced to the caller and never retried automatically.
 */
export interface HttpFrameworkClientOptions {
  baseUrl: string;
  tenantId: string;
  accessTokenProvider: AccessTokenProvider;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const SAFE = /^[A-Za-z0-9._:-]{1,128}$/;

function seg(value: string): string {
  if (!SAFE.test(value)) throw new FrameworkClientError("invalid_input", "identifier");
  return encodeURIComponent(value);
}

export class HttpFrameworkClient implements FrameworkClient {
  readonly mode = "live" as const;
  readonly #base: string;
  readonly #tenant: string;
  readonly #token: AccessTokenProvider;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #careOps: CareOpsHttpClient;

  constructor(options: HttpFrameworkClientOptions) {
    this.#base = new URL(options.baseUrl).origin;
    seg(options.tenantId);
    this.#tenant = options.tenantId;
    this.#token = options.accessTokenProvider;
    this.#fetch = options.fetchImpl ?? fetch.bind(globalThis);
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#careOps = new CareOpsHttpClient({ baseUrl: this.#base, accessTokenProvider: options.accessTokenProvider, fetchImpl: this.#fetch });
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const token = await this.#token();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(new URL(`/api/framework/tenants/${encodeURIComponent(this.#tenant)}/${path}`, this.#base), {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
    } catch {
      throw new FrameworkClientError("network");
    } finally {
      clearTimeout(timer);
    }
    let value: unknown = null;
    try {
      value = await response.json();
    } catch {
      throw new FrameworkClientError(response.ok ? "unknown" : response.status >= 500 ? "unavailable" : "unknown");
    }
    if (!response.ok) {
      const envelope = (value as { error?: { code?: unknown; details?: { reason?: unknown } } } | null)?.error;
      const failure = classifyFailure({ code: envelope?.code, reason: envelope?.details?.reason });
      if (failure.kind === "unknown" && response.status === 401) throw new FrameworkClientError("unauthenticated");
      if (failure.kind === "unknown" && response.status === 403) throw new FrameworkClientError("forbidden");
      if (failure.kind === "unknown" && response.status >= 500) throw new FrameworkClientError("unavailable");
      throw failure;
    }
    return value as T;
  }

  private async careOps<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      const e = error as { code?: unknown; status?: unknown; details?: { reason?: unknown } | null; name?: unknown };
      if (e?.name === "CareOpsHttpProtocolError") throw new FrameworkClientError("network");
      throw classifyFailure({ code: e?.code, reason: e?.details?.reason });
    }
  }

  async profile(): Promise<ProfileView> {
    const body = await this.call<{ profile: { displayName: string }; pack: { sector: ProfileView["sector"]; label: string; vocabulary: ProfileView["vocabulary"]; categories: ProfileView["categories"]; disclaimer: string } }>("GET", "profile");
    return {
      sector: body.pack.sector,
      organizationName: body.profile.displayName,
      sectorLabel: body.pack.label,
      vocabulary: body.pack.vocabulary,
      categories: body.pack.categories,
      disclaimer: body.pack.disclaimer,
    };
  }

  async search(text: string, category: string | null): Promise<ManualSearchHit[]> {
    const params = new URLSearchParams({ q: text });
    if (category) params.set("category", category);
    return (await this.call<{ hits: ManualSearchHit[] }>("GET", `manuals?${params}`)).hits;
  }

  async manual(manualId: string) {
    return this.call<{ manual: FrameworkManual; version: FrameworkManualVersion }>("GET", `manuals/${seg(manualId)}`);
  }

  async openCase(input: { manualId: string; manualVersion: number; signalId: string; subjectRef: string; priority?: CasePriority }) {
    const { manualId, ...rest } = input;
    const body = await this.call<{ aggregate: { id: string }; created: boolean }>("POST", `manuals/${seg(manualId)}/cases`, rest);
    return { caseId: body.aggregate.id, created: body.created };
  }

  async cases() {
    return this.careOps(() => this.#careOps.queue(this.#tenant));
  }

  async caseDetail(caseId: string): Promise<CaseDetailView> {
    const id = seg(caseId);
    const [stored, capabilities, manual, steps] = await Promise.all([
      this.careOps(() => this.#careOps.getCase(this.#tenant, caseId)),
      this.careOps(() => this.#careOps.caseCapabilities(this.#tenant, caseId)),
      this.call<{ link: CaseManualLink | null; manual: FrameworkManual | null; version: FrameworkManualVersion | null }>("GET", `cases/${id}/manual`),
      this.call<{ steps: ManualStep[]; checks: CaseStepCheck[] }>("GET", `cases/${id}/steps`),
    ]);
    return {
      stored,
      capabilities,
      manual: manual.link ? { link: manual.link, manual: manual.manual, version: manual.version } : null,
      steps: steps.steps,
      checks: steps.checks,
    };
  }

  async execute(caseId: string, expectedVersion: number, command: CaseCommandIntent) {
    await this.careOps(() => this.#careOps.execute(this.#tenant, caseId, expectedVersion, command));
  }

  async checkStep(caseId: string, stepId: string) {
    await this.call("POST", `cases/${seg(caseId)}/steps`, { stepId });
  }

  async evidence(caseId: string) {
    return this.call<unknown>("GET", `cases/${seg(caseId)}/evidence`);
  }

  async courses() {
    return (await this.call<{ courses: CourseListItem[] }>("GET", "training/courses")).courses;
  }

  async course(courseId: string) {
    return this.call<CourseDetailView>("GET", `training/courses/${seg(courseId)}`);
  }

  async submitQuiz(courseId: string, attemptId: string, answers: Record<string, string>) {
    return this.call<QuizOutcome>("POST", `training/courses/${seg(courseId)}/quiz`, { attemptId, answers });
  }

  async scenario(courseId: string, attemptId: string, answers: Array<{ stepId: string; choiceId: string }>, final: boolean) {
    return this.call<ScenarioOutcome>("POST", `training/courses/${seg(courseId)}/scenario`, { attemptId, answers, final });
  }

  async attempts() {
    return (await this.call<{ attempts: TrainingAttempt[] }>("GET", "training/attempts?scope=mine")).attempts;
  }

  /** Care Ops exposes only the active queue; completed Cases are reviewed via evidence export. */
  async caseHistory() {
    return null;
  }

  /** No staff directory API is exposed yet; the UI falls back to entering an actor ID. */
  async staffOptions(): Promise<StaffOption[]> {
    return [];
  }

  async whoAmI() {
    const operator = await this.careOps(() => this.#careOps.operatorContext(this.#tenant));
    return { actorId: operator.actorId, label: operator.actorId, roles: [...operator.roles] };
  }
}
