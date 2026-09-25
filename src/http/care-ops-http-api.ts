import {
  CaseService,
  type CaseCommandIntent,
} from "../application/index.ts";
import {
  CaseQueueService,
} from "../application/queue-service.ts";
import {
  CaseAccessDeniedError,
} from "../access/errors.ts";
import {
  CaseConflictError,
  InvalidTransitionError,
} from "../core/errors.ts";
import {
  CaseNotFoundError,
  CaseStoreCorruptionError,
  CaseStoreTransportError,
} from "../persistence/errors.ts";
import {
  TenantSlaPolicyNotFoundError,
} from "../operations/policy-directory.ts";
import { readBoundedJson } from "./body.ts";
import {
  parseCaseCommandRequest,
} from "./command-parser.ts";
import {
  AuthenticationRequiredError,
  HttpRequestError,
} from "./errors.ts";
import type {
  HttpApiErrorBody,
  RequestAuthenticator,
  RequestIdFactory,
} from "./types.ts";

export interface CareOpsHttpApiOptions {
  caseService: CaseService;
  queueService: CaseQueueService;
  authenticator: RequestAuthenticator;
  requestIdFactory?: RequestIdFactory;
  maxCommandBodyBytes?: number;
}

type Route =
  | {
      kind: "queue";
      tenantId: string;
    }
  | {
      kind: "case";
      tenantId: string;
      caseId: string;
    }
  | {
      kind: "commands";
      tenantId: string;
      caseId: string;
    };

const SAFE_IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/;

function requestIdFactory(): string {
  return crypto.randomUUID();
}

function safeIdentifier(
  raw: string,
  label: string,
): string {
  let decoded: string;

  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new HttpRequestError(
      400,
      "INVALID_PATH",
      "Path contains invalid encoding",
    );
  }

  if (!SAFE_IDENTIFIER.test(decoded)) {
    throw new HttpRequestError(
      400,
      "INVALID_PATH",
      `${label} is not a valid path identifier`,
    );
  }

  return decoded;
}

function routeFor(request: Request): Route {
  const url = new URL(request.url);
  const parts = url.pathname.split("/");

  if (
    parts.length === 5 &&
    parts[0] === "" &&
    parts[1] === "v1" &&
    parts[2] === "tenants" &&
    parts[4] === "cases"
  ) {
    return {
      kind: "queue",
      tenantId: safeIdentifier(
        parts[3]!,
        "tenantId",
      ),
    };
  }

  if (
    parts.length === 6 &&
    parts[0] === "" &&
    parts[1] === "v1" &&
    parts[2] === "tenants" &&
    parts[4] === "cases"
  ) {
    return {
      kind: "case",
      tenantId: safeIdentifier(
        parts[3]!,
        "tenantId",
      ),
      caseId: safeIdentifier(
        parts[5]!,
        "caseId",
      ),
    };
  }

  if (
    parts.length === 7 &&
    parts[0] === "" &&
    parts[1] === "v1" &&
    parts[2] === "tenants" &&
    parts[4] === "cases" &&
    parts[6] === "commands"
  ) {
    return {
      kind: "commands",
      tenantId: safeIdentifier(
        parts[3]!,
        "tenantId",
      ),
      caseId: safeIdentifier(
        parts[5]!,
        "caseId",
      ),
    };
  }

  throw new HttpRequestError(
    404,
    "ROUTE_NOT_FOUND",
    "Route not found",
  );
}

function allowedMethods(route: Route): readonly string[] {
  switch (route.kind) {
    case "queue":
    case "case":
      return ["GET"];
    case "commands":
      return ["POST"];
  }
}

function assertMethod(
  request: Request,
  route: Route,
): void {
  const allowed = allowedMethods(route);
  if (!allowed.includes(request.method)) {
    throw new HttpRequestError(
      405,
      "METHOD_NOT_ALLOWED",
      "Method not allowed",
    );
  }
}

function baseHeaders(
  requestId: string,
): Headers {
  return new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-request-id": requestId,
  });
}

function json(
  value: unknown,
  status: number,
  requestId: string,
  extraHeaders?: HeadersInit,
): Response {
  const headers = baseHeaders(requestId);

  if (extraHeaders) {
    const extras = new Headers(extraHeaders);
    extras.forEach((value, key) => {
      headers.set(key, value);
    });
  }

  return new Response(
    JSON.stringify(value),
    {
      status,
      headers,
    },
  );
}

function errorResponse(
  error: unknown,
  requestId: string,
): Response {
  if (error instanceof HttpRequestError) {
    return json(
      {
        error: {
          code: error.code,
          message: error.message,
          requestId,
        },
      } satisfies HttpApiErrorBody,
      error.status,
      requestId,
    );
  }

  if (error instanceof AuthenticationRequiredError) {
    return json(
      {
        error: {
          code: error.code,
          message: "Authentication required",
          requestId,
        },
      } satisfies HttpApiErrorBody,
      401,
      requestId,
    );
  }

  if (error instanceof CaseAccessDeniedError) {
    return json(
      {
        error: {
          code: "FORBIDDEN",
          message: "Access denied",
          requestId,
        },
      } satisfies HttpApiErrorBody,
      403,
      requestId,
    );
  }

  if (error instanceof CaseNotFoundError) {
    return json(
      {
        error: {
          code: error.code,
          message: "Case not found",
          requestId,
        },
      } satisfies HttpApiErrorBody,
      404,
      requestId,
    );
  }

  if (error instanceof CaseConflictError) {
    return json(
      {
        error: {
          code: error.code,
          message: "Case version conflict",
          requestId,
          details: {
            expectedVersion: error.expectedVersion,
            actualVersion: error.actualVersion,
          },
        },
      } satisfies HttpApiErrorBody,
      409,
      requestId,
    );
  }

  if (error instanceof InvalidTransitionError) {
    return json(
      {
        error: {
          code: error.code,
          message: "Case transition is not allowed",
          requestId,
        },
      } satisfies HttpApiErrorBody,
      409,
      requestId,
    );
  }

  if (
    error instanceof CaseStoreCorruptionError ||
    error instanceof CaseStoreTransportError ||
    error instanceof TenantSlaPolicyNotFoundError
  ) {
    return json(
      {
        error: {
          code: "CARE_OPS_UNAVAILABLE",
          message: "Care Operations service is unavailable",
          requestId,
        },
      } satisfies HttpApiErrorBody,
      503,
      requestId,
    );
  }

  return json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal server error",
        requestId,
      },
    } satisfies HttpApiErrorBody,
    500,
    requestId,
  );
}

function principalId(
  value: string,
): string {
  const normalized = value.trim();

  if (
    !normalized ||
    normalized.length > 256
  ) {
    throw new AuthenticationRequiredError();
  }

  return normalized;
}

export class CareOpsHttpApi {
  private readonly caseService: CaseService;
  private readonly queueService: CaseQueueService;
  private readonly authenticator: RequestAuthenticator;
  private readonly makeRequestId: RequestIdFactory;
  private readonly maxCommandBodyBytes: number;

  constructor(options: CareOpsHttpApiOptions) {
    this.caseService = options.caseService;
    this.queueService = options.queueService;
    this.authenticator = options.authenticator;
    this.makeRequestId =
      options.requestIdFactory ?? requestIdFactory;
    this.maxCommandBodyBytes =
      options.maxCommandBodyBytes ?? 32 * 1024;

    if (
      !Number.isInteger(this.maxCommandBodyBytes) ||
      this.maxCommandBodyBytes < 1
    ) {
      throw new Error(
        "maxCommandBodyBytes must be a positive integer",
      );
    }
  }

  private async authenticate(
    request: Request,
  ): Promise<string> {
    const authenticated =
      await this.authenticator.authenticate(request);

    if (!authenticated) {
      throw new AuthenticationRequiredError();
    }

    return principalId(authenticated.principalId);
  }

  private async executeCommand(
    request: Request,
    tenantId: string,
    caseId: string,
    authenticatedPrincipalId: string,
    requestId: string,
  ): Promise<Response> {
    const parsed = parseCaseCommandRequest(
      await readBoundedJson(
        request,
        this.maxCommandBodyBytes,
      ),
    );

    const result = await this.caseService.execute({
      tenantId,
      caseId,
      principalId: authenticatedPrincipalId,
      expectedVersion: parsed.expectedVersion,
      command: parsed.command as CaseCommandIntent,
    });

    return json(
      result,
      200,
      requestId,
      {
        "x-case-version":
          String(result.aggregate.version),
      },
    );
  }

  async handle(request: Request): Promise<Response> {
    const requestId = this.makeRequestId();

    try {
      const route = routeFor(request);
      assertMethod(request, route);
      const authenticatedPrincipalId =
        await this.authenticate(request);

      switch (route.kind) {
        case "queue": {
          const projection =
            await this.queueService.list({
              tenantId: route.tenantId,
              principalId:
                authenticatedPrincipalId,
            });

          return json(
            projection,
            200,
            requestId,
          );
        }

        case "case": {
          const stored = await this.caseService.get({
            tenantId: route.tenantId,
            caseId: route.caseId,
            principalId:
              authenticatedPrincipalId,
          });

          if (!stored) {
            throw new CaseNotFoundError(
              route.tenantId,
              route.caseId,
            );
          }

          return json(
            stored,
            200,
            requestId,
            {
              "x-case-version":
                String(stored.aggregate.version),
            },
          );
        }

        case "commands":
          return this.executeCommand(
            request,
            route.tenantId,
            route.caseId,
            authenticatedPrincipalId,
            requestId,
          );
      }
    } catch (error) {
      const response = errorResponse(
        error,
        requestId,
      );

      if (
        error instanceof HttpRequestError &&
        error.status === 405
      ) {
        try {
          const route = routeFor(request);
          response.headers.set(
            "allow",
            allowedMethods(route).join(", "),
          );
        } catch {
          // Preserve the original method error response.
        }
      }

      return response;
    }
  }
}
