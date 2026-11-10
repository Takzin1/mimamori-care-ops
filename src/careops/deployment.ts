import { PostgrestTenantMembershipDirectory } from "../access/postgrest-membership-directory.ts";
import type { TenantMembership, TenantMembershipDirectory } from "../access/types.ts";
import { AuthenticatedCareOpsGateway } from "../application/authenticated-gateway.ts";
import { CaseQueueService } from "../application/queue-service.ts";
import { CaseService } from "../application/case-service.ts";
import {
  parseCareOpsDeploymentEnvironment,
  type CareOpsDeploymentEnvironment,
  type DeploymentEnvironmentInput,
} from "../deployment/environment.ts";
import { CareOpsHttpApi } from "../http/care-ops-http-api.ts";
import { SupabaseAuthAuthenticator } from "../identity/supabase-authenticator.ts";
import { InMemoryTenantSlaPolicyDirectory } from "../operations/policy-directory.ts";
import { ExactBrowserOriginPolicy } from "../ops/exact-browser-origin-policy.ts";
import { OperationalCareOpsRuntime } from "../ops/operational-http-runtime.ts";
import type {
  CareOpsAdmissionDecision,
  CareOpsMetricsSink,
  CareOpsReadinessCheck,
  CareOpsRequestAdmission,
  CareOpsStructuredLogger,
} from "../ops/types.ts";
import { PostgrestCaseRepository } from "../persistence/postgrest-case-repository.ts";
import {
  DisabledAiDraftProvider,
  RuleBasedDraftProvider,
  type AiDraftProvider,
} from "./ai-assist.ts";
import { CareOpsPlatformHttpApi } from "./http.ts";
import { CareOpsPlatformService } from "./platform-service.ts";
import { createPostgrestPlatformStores, listTenantMemberships, type PostgrestJsonClient } from "./postgrest-stores.ts";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * CareOps platform options on top of the existing (strict) deployment
 * environment. Only non-secret switches live here.
 */
export interface CareOpsPlatformEnvironment {
  /** "disabled" (default) or the deterministic, network-free "local-rules". */
  aiProvider: "disabled" | "local-rules";
}

export function parseCareOpsPlatformEnvironment(input: DeploymentEnvironmentInput): CareOpsPlatformEnvironment {
  const raw = input.CARE_OPS_AI_PROVIDER?.trim() || "disabled";
  if (raw !== "disabled" && raw !== "local-rules") {
    // External LLM providers are intentionally not selectable until a
    // data-processing agreement and privacy review exist.
    throw new Error("CARE_OPS_AI_PROVIDER must be disabled or local-rules");
  }
  return { aiProvider: raw };
}

/** Membership directory with roster listing (PostgREST, service role). */
class PostgrestRosterDirectory implements TenantMembershipDirectory {
  readonly #directory: PostgrestTenantMembershipDirectory;
  readonly #client: PostgrestJsonClient;

  constructor(directory: PostgrestTenantMembershipDirectory, client: PostgrestJsonClient) {
    this.#directory = directory;
    this.#client = client;
  }

  findByPrincipal(tenantId: string, principalId: string) {
    return this.#directory.findByPrincipal(tenantId, principalId);
  }

  findByActorId(tenantId: string, actorId: string) {
    return this.#directory.findByActorId(tenantId, actorId);
  }

  listByTenant(tenantId: string): Promise<TenantMembership[]> {
    return listTenantMemberships(this.#client, tenantId);
  }
}

/**
 * Single-process fixed-window admission. Suitable for one staging
 * instance only; production must use the shared/edge admission provider
 * (docs/deployment-environment.md).
 */
export class InProcessFixedWindowAdmission implements CareOpsRequestAdmission {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #nowMs: () => number;
  #windowStart = 0;
  #count = 0;

  constructor(options: { limitPerWindow: number; windowMs: number; nowMs?: () => number }) {
    if (!Number.isInteger(options.limitPerWindow) || options.limitPerWindow < 1) throw new Error("limitPerWindow must be positive");
    if (!Number.isInteger(options.windowMs) || options.windowMs < 1000) throw new Error("windowMs must be >= 1000");
    this.#limit = options.limitPerWindow;
    this.#windowMs = options.windowMs;
    this.#nowMs = options.nowMs ?? (() => Date.now());
  }

  admit(): CareOpsAdmissionDecision {
    const now = this.#nowMs();
    if (now - this.#windowStart >= this.#windowMs) {
      this.#windowStart = now;
      this.#count = 0;
    }
    this.#count += 1;
    if (this.#count <= this.#limit) return { allowed: true };
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((this.#windowStart + this.#windowMs - now) / 1000)) };
  }
}

export interface CareOpsPlatformDeploymentOptions {
  env: DeploymentEnvironmentInput;
  admission: CareOpsRequestAdmission;
  logger?: CareOpsStructuredLogger;
  metrics?: CareOpsMetricsSink;
  readinessChecks?: readonly CareOpsReadinessCheck[];
  fetchImpl?: FetchLike;
  requestIdFactory?: () => string;
  clock?: () => string;
  nowMs?: () => number;
}

export interface CareOpsPlatformDeployment {
  runtime: OperationalCareOpsRuntime;
  platform: CareOpsPlatformService;
  config: CareOpsDeploymentEnvironment;
  platformConfig: CareOpsPlatformEnvironment;
}

/**
 * Production-shaped composition of the CareOps platform:
 * Supabase Auth verification → persistent tenant membership →
 * PostgREST/Postgres stores → CareOpsPlatformHttpApi (legacy routes
 * included) → OperationalCareOpsRuntime (health, readiness, exact
 * origin policy, admission, non-PII structured logs).
 *
 * The existing createCareOpsDeployment is unchanged.
 */
export function createCareOpsPlatformDeployment(options: CareOpsPlatformDeploymentOptions): CareOpsPlatformDeployment {
  const config = parseCareOpsDeploymentEnvironment(options.env);
  const platformConfig = parseCareOpsPlatformEnvironment(options.env);
  if (config.publishableKey === config.serviceRoleKey) {
    throw new Error("Supabase publishable and service-role keys must be different");
  }
  const now = options.clock ?? (() => new Date().toISOString());
  const common = {
    baseUrl: config.supabaseUrl,
    serviceRoleKey: config.serviceRoleKey,
    requestTimeoutMs: config.outboundTimeoutMs,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  };

  const authenticator = new SupabaseAuthAuthenticator({
    baseUrl: config.supabaseUrl,
    publishableKey: config.publishableKey,
    requestTimeoutMs: config.outboundTimeoutMs,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  const stores = createPostgrestPlatformStores(common);
  const memberships = new PostgrestRosterDirectory(new PostgrestTenantMembershipDirectory(common), stores.client);
  const repository = new PostgrestCaseRepository(common);
  const ai: AiDraftProvider = platformConfig.aiProvider === "local-rules"
    ? new RuleBasedDraftProvider()
    : new DisabledAiDraftProvider();

  const platform = new CareOpsPlatformService({
    repository,
    memberships,
    signals: stores.signals,
    settings: stores.settings,
    audit: stores.audit,
    drafts: stores.drafts,
    outbox: stores.outbox,
    inbox: stores.inbox,
    ai,
    now,
  });

  const legacy = new CareOpsHttpApi({
    gateway: new AuthenticatedCareOpsGateway({
      authenticator,
      caseService: new CaseService(repository, memberships, now),
      queueService: new CaseQueueService(repository, memberships, new InMemoryTenantSlaPolicyDirectory(config.slaPolicies), now),
    }),
    maxCommandBodyBytes: config.maxCommandBodyBytes,
    ...(options.requestIdFactory ? { requestIdFactory: options.requestIdFactory } : {}),
  });

  const api = new CareOpsPlatformHttpApi({
    platform,
    authenticator,
    legacy,
    maxBodyBytes: config.maxCommandBodyBytes,
    ...(options.requestIdFactory ? { requestIdFactory: options.requestIdFactory } : {}),
  });

  const storeReadiness: CareOpsReadinessCheck = {
    name: "careops_store",
    async check() {
      try {
        await stores.client.select("care_facility_settings", { select: "facility_id" }, 1);
        return true;
      } catch {
        return false;
      }
    },
  };

  const runtime = new OperationalCareOpsRuntime({
    handler: api,
    admission: options.admission,
    originPolicy: new ExactBrowserOriginPolicy(config.consoleOrigins),
    readinessChecks: [storeReadiness, ...(options.readinessChecks ?? [])],
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.metrics ? { metrics: options.metrics } : {}),
    ...(options.requestIdFactory ? { requestIdFactory: options.requestIdFactory } : {}),
    ...(options.clock ? { now: options.clock } : {}),
    ...(options.nowMs ? { nowMs: options.nowMs } : {}),
  });

  return { runtime, platform, config, platformConfig };
}
