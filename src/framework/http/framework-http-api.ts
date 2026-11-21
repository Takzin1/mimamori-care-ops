import { CaseAccessDeniedError } from "../../access/errors.ts";
import { CaseConflictError, InvalidTransitionError } from "../../core/errors.ts";
import { readBoundedJson } from "../../http/body.ts";
import { HttpRequestError } from "../../http/errors.ts";
import { AuthenticationError, type PrincipalAuthenticator } from "../../identity/types.ts";
import {
  CaseNotFoundError,
  CaseStoreTransportError,
  SignalReplayMismatchError,
} from "../../persistence/errors.ts";
import {
  FrameworkConflictError,
  FrameworkGovernanceError,
  FrameworkNotFoundError,
  FrameworkStoreUnavailableError,
  FrameworkValidationError,
} from "../errors.ts";
import type { FrameworkService } from "../framework-service.ts";

/**
 * Authenticated Framework HTTP boundary (`/api/framework/tenants/{tenantId}/...`).
 * Same contract as the Care Ops API (ADR 0009): Bearer token → PrincipalAuthenticator
 * → tenant membership; identity is never read from the body; strict paths; no CORS;
 * no-store; stable error envelope without internal identifiers.
 */
export interface FrameworkHttpApiOptions {
  authenticator: PrincipalAuthenticator;
  service: FrameworkService;
  extraRoutes?: FrameworkRouteHandler[];
  requestIdFactory?: () => string;
  maxBodyBytes?: number;
}

export interface FrameworkRouteContext {
  request: Request;
  url: URL;
  tenantId: string;
  segments: string[];
  principalId: string;
  body: () => Promise<Record<string, unknown>>;
}

export type FrameworkRouteResult = { status: number; body: unknown } | null;

/** Additional route modules (training, evidence) plug in without changing this file's contract. */
export type FrameworkRouteHandler = (context: FrameworkRouteContext) => Promise<FrameworkRouteResult>;

const SAFE_SEGMENT = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_ACCESS_TOKEN_LENGTH = 8 * 1024;

function bearer(request: Request): string {
  const header = request.headers.get("authorization");
  const match = header ? /^Bearer ([^\s,]+)$/i.exec(header) : null;
  if (!match || match[1]!.length > MAX_ACCESS_TOKEN_LENGTH) throw new AuthenticationError();
  return match[1]!;
}

function headers(requestId: string): Headers {
  return new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    vary: "Authorization",
    "x-request-id": requestId,
  });
}

function json(value: unknown, status: number, requestId: string): Response {
  return new Response(JSON.stringify(value), { status, headers: headers(requestId) });
}

function error(code: string, message: string, status: number, requestId: string, details?: Record<string, unknown>): Response {
  return json({ error: { code, message, requestId, ...(details ? { details } : {}) } }, status, requestId);
}

export function frameworkErrorResponse(failure: unknown, requestId: string): Response {
  if (failure instanceof HttpRequestError) return error(failure.code, failure.message, failure.status, requestId);
  if (failure instanceof AuthenticationError) return error("AUTHENTICATION_REQUIRED", "Authentication required", 401, requestId);
  if (failure instanceof CaseAccessDeniedError) return error("FORBIDDEN", "Access denied", 403, requestId);
  if (failure instanceof FrameworkGovernanceError) {
    return error(failure.code, "This action requires a different reviewer or the author", 403, requestId, { reason: failure.reason });
  }
  if (failure instanceof FrameworkValidationError) return error(failure.code, failure.message, 400, requestId);
  if (failure instanceof FrameworkNotFoundError || failure instanceof CaseNotFoundError) {
    return error("NOT_FOUND", "Not found", 404, requestId);
  }
  if (failure instanceof FrameworkConflictError) {
    return error(failure.code, "The resource changed or conflicts with an earlier request", 409, requestId, { reason: failure.reason });
  }
  if (failure instanceof CaseConflictError) {
    return error(failure.code, "Case version conflict", 409, requestId, {
      expectedVersion: failure.expectedVersion,
      actualVersion: failure.actualVersion,
    });
  }
  if (failure instanceof SignalReplayMismatchError) {
    return error(failure.code, "Signal was already reported with different content", 409, requestId);
  }
  if (failure instanceof InvalidTransitionError) return error(failure.code, "Case transition is not allowed", 422, requestId);
  if (failure instanceof FrameworkStoreUnavailableError || failure instanceof CaseStoreTransportError) {
    return error("FRAMEWORK_UNAVAILABLE", "Framework storage is unavailable", 503, requestId);
  }
  return error("INTERNAL_ERROR", "Internal server error", 500, requestId);
}

function versionNumber(value: string): number {
  if (!/^[1-9][0-9]{0,5}$/.test(value)) throw new HttpRequestError(400, "INVALID_PATH", "version is not valid");
  return Number(value);
}

/** Manual Engine, Search and Manual→Case routes (P1). */
export function manualRoutes(service: FrameworkService): FrameworkRouteHandler {
  return async ({ request, url, tenantId, segments, principalId, body }) => {
    const method = request.method;
    const [a, b, c, d, e] = segments;

    if (segments.length === 1 && a === "profile") {
      if (method === "GET") return { status: 200, body: await service.profile(principalId, tenantId) };
      if (method === "POST") {
        const input = await body();
        return { status: 200, body: { profile: await service.configureTenant(principalId, tenantId, { sector: input.sector, displayName: input.displayName }) } };
      }
    }

    if (segments.length === 2 && a === "templates" && b === "install" && method === "POST") {
      return { status: 200, body: await service.installPackTemplates(principalId, tenantId) };
    }

    if (a === "manuals") {
      if (segments.length === 1 && method === "GET") {
        const hits = await service.search(principalId, tenantId, {
          text: url.searchParams.get("q") ?? "",
          category: url.searchParams.get("category"),
          limit: url.searchParams.get("limit") ?? undefined,
        });
        return { status: 200, body: { hits } };
      }
      if (segments.length === 2 && method === "GET") {
        return { status: 200, body: await service.fieldManual(principalId, tenantId, b!) };
      }
      if (segments.length === 4 && c === "versions" && method === "GET") {
        return { status: 200, body: await service.manualVersion(principalId, tenantId, b!, versionNumber(d!)) };
      }
      if (segments.length === 3 && c === "cases" && method === "POST") {
        const input = await body();
        const allowed = new Set(["manualVersion", "signalId", "subjectRef", "priority"]);
        const unknown = Object.keys(input).find((k) => !allowed.has(k));
        if (unknown) throw new FrameworkValidationError(`unsupported field: ${unknown}`);
        if (!Number.isInteger(input.manualVersion)) throw new FrameworkValidationError("manualVersion must be an integer");
        const result = await service.openCaseFromManual(principalId, tenantId, {
          manualId: b!,
          manualVersion: input.manualVersion as number,
          signalId: input.signalId as string,
          subjectRef: input.subjectRef as string,
          ...(input.priority !== undefined ? { priority: input.priority as never } : {}),
        });
        return { status: result.created ? 201 : 200, body: result };
      }
    }

    if (a === "authoring" && b === "manuals") {
      if (segments.length === 2 && method === "GET") {
        return { status: 200, body: { manuals: await service.listManualsForAuthoring(principalId, tenantId) } };
      }
      if (segments.length === 2 && method === "POST") {
        return { status: 201, body: await service.createManual(principalId, tenantId, await body()) };
      }
      if (segments.length === 4 && d === "versions" && method === "POST") {
        return { status: 201, body: { version: await service.reviseManual(principalId, tenantId, c!, await body()) } };
      }
      if (segments.length === 6 && d === "versions" && method === "POST") {
        const version = versionNumber(e!);
        const action = segments[5];
        if (action === "submit") return { status: 200, body: { version: await service.submitVersion(principalId, tenantId, c!, version) } };
        if (action === "retire") return { status: 200, body: { version: await service.retireVersion(principalId, tenantId, c!, version) } };
        if (action === "review") {
          const input = await body();
          return {
            status: 200,
            body: { version: await service.reviewVersion(principalId, tenantId, c!, version, { approve: input.approve, effectiveUntil: input.effectiveUntil }) },
          };
        }
      }
    }

    if (a === "cases" && segments.length === 3 && c === "manual" && method === "GET") {
      return { status: 200, body: await service.caseManual(principalId, tenantId, b!) };
    }

    return null;
  };
}

export class FrameworkHttpApi {
  private readonly authenticator: PrincipalAuthenticator;
  private readonly routes: FrameworkRouteHandler[];
  private readonly makeRequestId: () => string;
  private readonly maxBodyBytes: number;

  constructor(options: FrameworkHttpApiOptions) {
    this.authenticator = options.authenticator;
    this.routes = [manualRoutes(options.service), ...(options.extraRoutes ?? [])];
    this.makeRequestId = options.requestIdFactory ?? (() => crypto.randomUUID());
    this.maxBodyBytes = options.maxBodyBytes ?? 32 * 1024;
  }

  async handle(request: Request): Promise<Response> {
    const requestId = this.makeRequestId();
    try {
      const url = new URL(request.url);
      const parts = url.pathname.split("/");
      if (parts.length < 6 || parts[0] !== "" || parts[1] !== "api" || parts[2] !== "framework" || parts[3] !== "tenants") {
        throw new HttpRequestError(404, "ROUTE_NOT_FOUND", "Route not found");
      }
      const decoded = parts.slice(4).map((part) => {
        let value: string;
        try {
          value = decodeURIComponent(part);
        } catch {
          throw new HttpRequestError(400, "INVALID_PATH", "Path contains invalid encoding");
        }
        if (!SAFE_SEGMENT.test(value)) throw new HttpRequestError(400, "INVALID_PATH", "Path segment is not valid");
        return value;
      });
      const [tenantId, ...segments] = decoded;
      if (!["GET", "POST"].includes(request.method)) {
        throw new HttpRequestError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
      }
      const token = bearer(request);
      const principal = await this.authenticator.authenticate(token);
      let cachedBody: Record<string, unknown> | null = null;
      const context: FrameworkRouteContext = {
        request,
        url,
        tenantId: tenantId!,
        segments,
        principalId: principal.principalId,
        body: async () => {
          if (cachedBody) return cachedBody;
          const value = await readBoundedJson(request, this.maxBodyBytes);
          if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw new FrameworkValidationError("Request body must be an object");
          }
          cachedBody = value as Record<string, unknown>;
          return cachedBody;
        },
      };
      for (const route of this.routes) {
        const result = await route(context);
        if (result) return json(result.body, result.status, requestId);
      }
      throw new HttpRequestError(404, "ROUTE_NOT_FOUND", "Route not found");
    } catch (failure) {
      return frameworkErrorResponse(failure, requestId);
    }
  }
}
