import { CaseAccessDeniedError } from "../access/errors.ts";
import { readBoundedJson } from "../http/body.ts";
import {
  careOpsBearerToken,
  careOpsErrorResponse,
  careOpsJson,
  type CareOpsHttpApi,
} from "../http/care-ops-http-api.ts";
import { parseCaseCommandRequest } from "../http/command-parser.ts";
import { HttpRequestError } from "../http/errors.ts";
import type { PrincipalAuthenticator } from "../identity/types.ts";
import {
  CareOpsConflictError,
  CareOpsNotFoundError,
  CareOpsRuleError,
} from "./errors.ts";
import {
  SAFE_ID,
  optionalFacilityParam,
  parseAiDraftRequest,
  parseAiReview,
  parseAnalyticsQuery,
  parseCaseFromSignal,
  parseCaseListQuery,
  parseLimit,
  parseManualCase,
  parseReason,
  parseSettingsUpdate,
  parseSignalIntake,
  parseSignalListQuery,
} from "./http-parsers.ts";
import type { CareOpsPlatformService, PlatformContext } from "./platform-service.ts";

export interface CareOpsPlatformHttpApiOptions {
  platform: CareOpsPlatformService;
  authenticator: PrincipalAuthenticator;
  /** Existing Care Ops HTTP API; serves every route not handled here. */
  legacy: CareOpsHttpApi;
  requestIdFactory?: () => string;
  maxBodyBytes?: number;
}

type Handler = (input: {
  request: Request;
  url: URL;
  ctx: PlatformContext;
  params: string[];
  body: () => Promise<unknown>;
}) => Promise<unknown>;

interface RouteDef {
  method: "GET" | "POST";
  /** Path segments after /api/care-ops/tenants/:tenantId/ ; ":" = id. */
  pattern: string[];
  handler: Handler;
  status?: number;
}

const PREFIX = ["", "api", "care-ops", "tenants"];

function decodeSegment(raw: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new HttpRequestError(400, "INVALID_PATH", "Path contains invalid encoding");
  }
  if (!SAFE_ID.test(decoded)) {
    throw new HttpRequestError(400, "INVALID_PATH", "Path identifier is invalid");
  }
  return decoded;
}

function platformErrorResponse(error: unknown, requestId: string): Response {
  const body = (code: string, message: string) => ({ error: { code, message, requestId } });
  if (error instanceof CareOpsNotFoundError) {
    return careOpsJson(body("NOT_FOUND", `${error.resource} not found`), 404, requestId);
  }
  if (error instanceof CareOpsConflictError) {
    return careOpsJson(body("CONFLICT", "The resource was changed concurrently; reload and retry"), 409, requestId);
  }
  if (error instanceof CareOpsRuleError) {
    return careOpsJson(body(error.code, error.message), error.code === "INVALID_INPUT" ? 400 : 422, requestId);
  }
  if (error instanceof CaseAccessDeniedError) {
    return careOpsJson(body("FORBIDDEN", "Access denied"), 403, requestId);
  }
  return careOpsErrorResponse(error, requestId);
}

export class CareOpsPlatformHttpApi {
  readonly #platform: CareOpsPlatformService;
  readonly #authenticator: PrincipalAuthenticator;
  readonly #legacy: CareOpsHttpApi;
  readonly #requestId: () => string;
  readonly #maxBodyBytes: number;
  readonly #routes: RouteDef[];

  constructor(options: CareOpsPlatformHttpApiOptions) {
    this.#platform = options.platform;
    this.#authenticator = options.authenticator;
    this.#legacy = options.legacy;
    this.#requestId = options.requestIdFactory ?? (() => crypto.randomUUID());
    this.#maxBodyBytes = options.maxBodyBytes ?? 32 * 1024;
    const p = this.#platform;

    this.#routes = [
      { method: "GET", pattern: ["me"], handler: ({ ctx }) => p.operator(ctx) },
      { method: "GET", pattern: ["permissions"], handler: ({ ctx }) => p.permissions(ctx) },
      { method: "GET", pattern: ["staff"], handler: ({ ctx, url }) => p.staff(ctx, optionalFacilityParam(url.searchParams)) },
      { method: "GET", pattern: ["facilities"], handler: ({ ctx }) => p.facilities(ctx) },
      { method: "GET", pattern: ["dashboard"], handler: ({ ctx, url }) => p.dashboard(ctx, optionalFacilityParam(url.searchParams)) },
      { method: "GET", pattern: ["cases"], handler: ({ ctx, url }) => p.listCases(ctx, parseCaseListQuery(url.searchParams)) },
      { method: "POST", pattern: ["cases"], status: 201, handler: async ({ ctx, body }) => p.createCase(ctx, parseManualCase(await body())) },
      { method: "GET", pattern: ["cases", ":", "detail"], handler: ({ ctx, params }) => p.caseDetail(ctx, params[0]!) },
      {
        method: "POST",
        pattern: ["cases", ":", "commands"],
        handler: async ({ ctx, params, body }) => {
          const parsed = parseCaseCommandRequest(await body());
          return p.execute(ctx, params[0]!, parsed.expectedVersion, parsed.command);
        },
      },
      { method: "POST", pattern: ["cases", ":", "ai-drafts"], status: 201, handler: async ({ ctx, params, body }) => p.requestAiDraft(ctx, params[0]!, parseAiDraftRequest(await body())) },
      { method: "POST", pattern: ["cases", ":", "ai-drafts", ":", "review"], handler: async ({ ctx, params, body }) => p.reviewAiDraft(ctx, params[0]!, params[1]!, parseAiReview(await body())) },
      { method: "GET", pattern: ["signals"], handler: ({ ctx, url }) => p.listSignals(ctx, parseSignalListQuery(url.searchParams)) },
      { method: "POST", pattern: ["signals"], status: 201, handler: async ({ ctx, body }) => p.ingestSignal(ctx, parseSignalIntake(await body())) },
      { method: "POST", pattern: ["signals", ":", "create-case"], status: 201, handler: async ({ ctx, params, body }) => p.createCaseFromSignal(ctx, params[0]!, parseCaseFromSignal(await body())) },
      { method: "POST", pattern: ["signals", ":", "dismiss"], handler: async ({ ctx, params, body }) => p.dismissSignal(ctx, params[0]!, parseReason(await body())) },
      { method: "GET", pattern: ["handoffs"], handler: ({ ctx }) => p.handoffBoard(ctx) },
      { method: "GET", pattern: ["analytics"], handler: ({ ctx, url }) => p.analytics(ctx, parseAnalyticsQuery(url.searchParams)) },
      { method: "GET", pattern: ["settings", "facilities", ":"], handler: ({ ctx, params }) => p.getSettings(ctx, params[0]!) },
      {
        method: "POST",
        pattern: ["settings", "facilities", ":"],
        handler: async ({ ctx, params, body }) => {
          const parsed = parseSettingsUpdate(await body());
          return p.updateSettings(ctx, params[0]!, parsed.expectedVersion, parsed.patch);
        },
      },
      {
        method: "GET",
        pattern: ["audit"],
        handler: ({ ctx, url }) => {
          const limit = parseLimit(url.searchParams);
          const facilityId = optionalFacilityParam(url.searchParams);
          return p.auditLog(ctx, { ...(limit ? { limit } : {}), ...(facilityId ? { facilityId } : {}) });
        },
      },
      { method: "GET", pattern: ["notifications"], handler: ({ ctx }) => p.notifications(ctx) },
      { method: "GET", pattern: ["notifications", "deliveries"], handler: ({ ctx }) => p.deliveryStatus(ctx) },
      { method: "POST", pattern: ["escalations", "run"], handler: ({ ctx }) => p.runEscalations(ctx) },
    ];
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/");
    const isTenantPath = parts.length >= 6 && PREFIX.every((segment, index) => parts[index] === segment);
    const rest = parts.slice(5);
    const candidates = isTenantPath
      ? this.#routes.filter((route) =>
          route.pattern.length === rest.length &&
          route.pattern.every((segment, index) => segment === ":" || segment === rest[index]),
        )
      : [];

    if (candidates.length === 0) {
      return this.#legacy.handle(request);
    }

    const requestId = this.#requestId();
    const route = candidates.find((item) => item.method === request.method);
    try {
      if (!route) {
        const response = careOpsJson(
          { error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed", requestId } },
          405,
          requestId,
        );
        response.headers.set("allow", [...new Set(candidates.map((item) => item.method))].join(", "));
        return response;
      }
      const tenantId = decodeSegment(parts[4]!);
      const params = route.pattern
        .map((segment, index) => (segment === ":" ? decodeSegment(rest[index]!) : null))
        .filter((value): value is string => value !== null);

      const token = careOpsBearerToken(request);
      const principal = await this.#authenticator.authenticate(token);
      const ctx: PlatformContext = { tenantId, principalId: principal.principalId };
      const result = await route.handler({
        request,
        url,
        ctx,
        params,
        body: () => readBoundedJson(request, this.#maxBodyBytes),
      });
      return careOpsJson(result ?? { ok: true }, route.status ?? 200, requestId);
    } catch (error) {
      return platformErrorResponse(error, requestId);
    }
  }
}
