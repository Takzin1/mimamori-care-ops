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
  PrincipalAuthenticator,
} from "../identity/types.ts";
import {
  LineAccessTokenAuthenticator,
} from "../identity/line-access-token-authenticator.ts";
import {
  IssuerRoutingAuthenticator,
  supabaseAuthIssuer,
} from "../identity/issuer-routing-authenticator.ts";
import {
  FrameworkHttpApi,
  recordRoutes,
} from "../framework/http/framework-http-api.ts";
import {
  FrameworkService,
} from "../framework/framework-service.ts";
import {
  FrameworkRecordsService,
} from "../framework/records-service.ts";
import {
  PostgrestFrameworkStore,
} from "../framework/store/postgrest-framework-store.ts";

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
  fetchImpl?: FetchLike;
  casePageSize?: number;
  outboundTimeoutMs?: number;
  maxCommandBodyBytes?: number;
  requestIdFactory?: RequestIdFactory;
  clock?: RuntimeClock;
  /** When set, LINE Login access tokens are also accepted (ADR 0019 / 0021). */
  lineChannelId?: string | null;
  /** Mounts the Framework API under /api/framework/ (ADR 0020 / 0021). Off by default. */
  frameworkEnabled?: boolean;
}

const FRAMEWORK_PATH_PREFIX = "/api/framework/";

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

export class SupabaseCareOpsRuntime {
  readonly #http: CareOpsHttpApi;
  readonly #framework: FrameworkHttpApi | null;

  constructor(
    options: SupabaseCareOpsRuntimeOptions,
  ) {
    assertRuntimeConfig(options);

    const now =
      options.clock ??
      (() => new Date().toISOString());

    const supabaseAuthenticator =
      new SupabaseAuthAuthenticator({
        baseUrl: options.supabaseUrl,
        publishableKey:
          options.publishableKey,
        fetchImpl: options.fetchImpl,
        requestTimeoutMs:
          options.outboundTimeoutMs,
      });

    // Without a LINE channel the runtime behaves exactly as before (Supabase Auth only).
    const authenticator: PrincipalAuthenticator =
      options.lineChannelId
        ? new IssuerRoutingAuthenticator({
            supabaseIssuer:
              supabaseAuthIssuer(
                options.supabaseUrl,
              ),
            supabase:
              supabaseAuthenticator,
            fallback:
              new LineAccessTokenAuthenticator({
                channelId:
                  options.lineChannelId,
                fetchImpl:
                  options.fetchImpl,
                requestTimeoutMs:
                  options.outboundTimeoutMs,
              }),
          })
        : supabaseAuthenticator;

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

    if (options.frameworkEnabled) {
      const store =
        new PostgrestFrameworkStore({
          baseUrl: options.supabaseUrl,
          serviceRoleKey:
            options.serviceRoleKey,
          fetchImpl: options.fetchImpl,
          requestTimeoutMs:
            options.outboundTimeoutMs,
        });
      const framework =
        new FrameworkService({
          store,
          memberships,
          caseService,
          now,
        });
      const records =
        new FrameworkRecordsService({
          store,
          memberships,
          caseService,
          now,
        });

      this.#framework =
        new FrameworkHttpApi({
          authenticator,
          service: framework,
          extraRoutes: [
            recordRoutes(records),
          ],
          maxBodyBytes:
            options.maxCommandBodyBytes,
          requestIdFactory:
            options.requestIdFactory,
        });
    } else {
      this.#framework = null;
    }
  }

  handle(
    request: Request,
  ): Promise<Response> {
    if (
      this.#framework &&
      new URL(request.url).pathname.startsWith(
        FRAMEWORK_PATH_PREFIX,
      )
    ) {
      return this.#framework.handle(request);
    }

    return this.#http.handle(request);
  }
}

export function createSupabaseCareOpsRuntime(
  options: SupabaseCareOpsRuntimeOptions,
): SupabaseCareOpsRuntime {
  return new SupabaseCareOpsRuntime(options);
}
