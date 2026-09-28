import {
  PostgrestTenantMembershipDirectory,
} from "../access/postgrest-membership-directory.ts";
import {
  AuthenticatedCareOpsGateway,
} from "../application/authenticated-gateway.ts";
import {
  CaseQueueService,
} from "../application/queue-service.ts";
import {
  CaseService,
} from "../application/case-service.ts";
import {
  CareOpsHttpApi,
} from "../http/care-ops-http-api.ts";
import {
  VoiceSessionHttpApi,
} from "../http/voice-session-http-api.ts";
import type {
  RequestIdFactory,
} from "../http/types.ts";
import {
  SupabaseAuthAuthenticator,
} from "../identity/supabase-authenticator.ts";
import {
  InMemoryTenantSlaPolicyDirectory,
} from "../operations/policy-directory.ts";
import type {
  CaseSlaPolicy,
} from "../operations/sla.ts";
import {
  PostgrestCaseRepository,
} from "../persistence/postgrest-case-repository.ts";
import type {
  VoiceRealtimeSessionIssuer,
} from "../voice/index.ts";

type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type RuntimeClock = () => string;

export interface SupabaseCareOpsRuntimeOptions {
  supabaseUrl: string;
  publishableKey: string;
  serviceRoleKey: string;
  slaPolicies: Readonly<Record<string, CaseSlaPolicy>>;
  voiceSessionIssuer?: VoiceRealtimeSessionIssuer;
  fetchImpl?: FetchLike;
  casePageSize?: number;
  outboundTimeoutMs?: number;
  maxCommandBodyBytes?: number;
  requestIdFactory?: RequestIdFactory;
  clock?: RuntimeClock;
}

function requiredText(
  value: string,
  label: string,
): string {
  const normalized = value.trim();

  if (!normalized) {
    throw new Error(`${label} is required`);
  }

  return normalized;
}

function assertRuntimeConfig(
  options: SupabaseCareOpsRuntimeOptions,
): void {
  const publishableKey = requiredText(
    options.publishableKey,
    "Supabase publishable key",
  );
  const serviceRoleKey = requiredText(
    options.serviceRoleKey,
    "Supabase service-role key",
  );

  requiredText(
    options.supabaseUrl,
    "Supabase URL",
  );

  if (publishableKey === serviceRoleKey) {
    throw new Error(
      "Supabase publishable and service-role keys must be different",
    );
  }

  if (
    Object.keys(options.slaPolicies).length === 0
  ) {
    throw new Error(
      "At least one tenant SLA policy is required",
    );
  }
}

function isVoiceSessionPath(
  request: Request,
): boolean {
  const pathname =
    new URL(request.url)
      .pathname;

  return /^\/api\/care-ops\/tenants\/[^/]+\/voice\/session$/.test(
    pathname,
  );
}

export class SupabaseCareOpsRuntime {
  readonly #http: CareOpsHttpApi;
  readonly #voiceHttp:
    VoiceSessionHttpApi | null;

  constructor(
    options: SupabaseCareOpsRuntimeOptions,
  ) {
    assertRuntimeConfig(options);

    const now =
      options.clock ??
      (() => new Date().toISOString());

    const authenticator =
      new SupabaseAuthAuthenticator({
        baseUrl: options.supabaseUrl,
        publishableKey:
          options.publishableKey,
        fetchImpl: options.fetchImpl,
        requestTimeoutMs:
          options.outboundTimeoutMs,
      });

    const memberships =
      new PostgrestTenantMembershipDirectory({
        baseUrl: options.supabaseUrl,
        serviceRoleKey:
          options.serviceRoleKey,
        fetchImpl: options.fetchImpl,
        requestTimeoutMs:
          options.outboundTimeoutMs,
      });

    const repository =
      new PostgrestCaseRepository({
        baseUrl: options.supabaseUrl,
        serviceRoleKey:
          options.serviceRoleKey,
        fetchImpl: options.fetchImpl,
        pageSize: options.casePageSize,
        requestTimeoutMs:
          options.outboundTimeoutMs,
      });

    const policies =
      new InMemoryTenantSlaPolicyDirectory(
        options.slaPolicies,
      );

    const caseService = new CaseService(
      repository,
      memberships,
      now,
    );

    const queueService =
      new CaseQueueService(
        repository,
        memberships,
        policies,
        now,
      );

    const gateway =
      new AuthenticatedCareOpsGateway({
        authenticator,
        caseService,
        queueService,
      });

    this.#http = new CareOpsHttpApi({
      gateway,
      maxCommandBodyBytes:
        options.maxCommandBodyBytes,
      requestIdFactory:
        options.requestIdFactory,
    });

    this.#voiceHttp =
      options.voiceSessionIssuer
        ? new VoiceSessionHttpApi({
            gateway,
            issuer:
              options.voiceSessionIssuer,
            now,
          })
        : null;
  }

  handle(
    request: Request,
  ): Promise<Response> {
    if (
      this.#voiceHttp &&
      isVoiceSessionPath(
        request,
      )
    ) {
      return this.#voiceHttp
        .handle(request);
    }

    return this.#http
      .handle(request);
  }
}

export function createSupabaseCareOpsRuntime(
  options: SupabaseCareOpsRuntimeOptions,
): SupabaseCareOpsRuntime {
  return new SupabaseCareOpsRuntime(options);
}
