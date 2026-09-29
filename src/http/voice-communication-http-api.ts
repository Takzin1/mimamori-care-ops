import {
  CaseAccessDeniedError,
} from "../access/errors.ts";
import type {
  OperatorContextProjection,
} from "../application/capabilities.ts";
import {
  AuthenticationError,
} from "../identity/types.ts";
import type {
  OutboxStore,
} from "../outbox/types.ts";
import {
  approveCommunication,
  toCommunicationOutbox,
  type CommunicationDraft,
} from "../voice/index.ts";
import {
  readBoundedJson,
} from "./body.ts";

const MAX_ACCESS_TOKEN_LENGTH =
  8 * 1024;
const MAX_BODY_BYTES =
  32 * 1024;

export interface VoiceCommunicationGateway {
  operatorContext(input: {
    accessToken: string;
    tenantId: string;
  }): Promise<OperatorContextProjection>;
}

export interface VoiceCommunicationHttpApiOptions {
  gateway:
    VoiceCommunicationGateway;
  outbox:
    OutboxStore;
  now?: () => string;
}

function bearer(
  request: Request,
): string {
  const header =
    request.headers.get(
      "authorization",
    );
  const match =
    header
      ? /^Bearer ([^\s,]+)$/i.exec(
          header,
        )
      : null;

  if (
    !match ||
    match[1]!.length >
      MAX_ACCESS_TOKEN_LENGTH
  ) {
    throw new AuthenticationError();
  }

  return match[1]!;
}

function tenantFromPath(
  request: Request,
): string | null {
  const parts =
    new URL(request.url)
      .pathname
      .split("/");

  if (
    parts.length !== 8 ||
    parts[0] !== "" ||
    parts[1] !== "api" ||
    parts[2] !== "care-ops" ||
    parts[3] !== "tenants" ||
    parts[5] !== "voice" ||
    parts[6] !== "communications" ||
    parts[7] !== "approve"
  ) {
    return null;
  }

  let tenant: string;

  try {
    tenant =
      decodeURIComponent(
        parts[4]!,
      );
  } catch {
    return null;
  }

  return /^[A-Za-z0-9._:-]{1,128}$/.test(
    tenant,
  )
    ? tenant
    : null;
}

function canApprove(
  operator:
    OperatorContextProjection,
): boolean {
  return operator.roles.some(
    (role) =>
      role === "responder" ||
      role === "dispatcher" ||
      role === "supervisor",
  );
}

function draftFromBody(
  value: unknown,
): CommunicationDraft {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error(
      "communication approval body must be an object",
    );
  }

  const body =
    value as Record<
      string,
      unknown
    >;

  if (
    Object.keys(body).length !== 1 ||
    !(
      "draft" in body
    )
  ) {
    throw new Error(
      "communication approval body must contain only draft",
    );
  }

  const raw =
    body.draft;

  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw)
  ) {
    throw new Error(
      "communication draft is invalid",
    );
  }

  const record =
    raw as Record<
      string,
      unknown
    >;

  const allowed = [
    "id",
    "caseId",
    "audience",
    "channel",
    "body",
    "requiresHumanApproval",
  ];

  const keys =
    Object.keys(record);

  if (
    keys.length !==
      allowed.length ||
    keys.some(
      (key) =>
        !allowed.includes(key),
    )
  ) {
    throw new Error(
      "communication draft has unexpected or missing fields",
    );
  }

  if (
    typeof record.id !==
      "string" ||
    !record.id.trim() ||
    record.id.length > 512 ||
    typeof record.caseId !==
      "string" ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(
      record.caseId,
    ) ||
    (
      record.audience !==
        "supervisor" &&
      record.audience !==
        "family"
    ) ||
    record.channel !==
      "message" ||
    typeof record.body !==
      "string" ||
    !record.body.trim() ||
    record.body.length >
      8_000 ||
    record.requiresHumanApproval !==
      true
  ) {
    throw new Error(
      "communication draft is invalid",
    );
  }

  const id =
    record.id.trim();
  const caseId =
    record.caseId;
  const audience =
    record.audience;

  if (
    !id.startsWith(
      `${caseId}:${audience}:`,
    )
  ) {
    throw new Error(
      "communication draft identity does not match case and audience",
    );
  }

  return {
    id,
    caseId,
    audience,
    channel:
      "message",
    body:
      record.body.trim(),
    requiresHumanApproval:
      true,
  };
}

function json(
  status: number,
  body: unknown,
): Response {
  return new Response(
    JSON.stringify(body),
    {
      status,
      headers: {
        "content-type":
          "application/json; charset=utf-8",
        "cache-control":
          "no-store",
        "x-content-type-options":
          "nosniff",
        "referrer-policy":
          "no-referrer",
      },
    },
  );
}

export class VoiceCommunicationHttpApi {
  readonly #gateway:
    VoiceCommunicationGateway;
  readonly #outbox:
    OutboxStore;
  readonly #now:
    () => string;

  constructor(
    options:
      VoiceCommunicationHttpApiOptions,
  ) {
    this.#gateway =
      options.gateway;
    this.#outbox =
      options.outbox;
    this.#now =
      options.now ??
      (() =>
        new Date()
          .toISOString());
  }

  async handle(
    request: Request,
  ): Promise<Response> {
    try {
      const tenantId =
        tenantFromPath(
          request,
        );

      if (!tenantId) {
        return json(
          404,
          {
            error: {
              code:
                "ROUTE_NOT_FOUND",
              message:
                "Route not found",
            },
          },
        );
      }

      if (
        request.method !==
          "POST"
      ) {
        const response =
          json(
            405,
            {
              error: {
                code:
                  "METHOD_NOT_ALLOWED",
                message:
                  "Method not allowed",
              },
            },
          );
        response.headers.set(
          "allow",
          "POST",
        );
        return response;
      }

      const accessToken =
        bearer(
          request,
        );

      const operator =
        await this.#gateway
          .operatorContext({
            accessToken,
            tenantId,
          });

      if (
        !canApprove(
          operator,
        )
      ) {
        throw new CaseAccessDeniedError(
          "command_forbidden",
        );
      }

      const draft =
        draftFromBody(
          await readBoundedJson(
            request,
            MAX_BODY_BYTES,
          ),
        );

      const approved =
        approveCommunication(
          draft,
          operator.actorId,
          this.#now(),
        );

      const enqueue =
        toCommunicationOutbox(
          tenantId,
          approved,
        );

      const queued =
        await this.#outbox
          .enqueue(
            enqueue,
          );

      return json(
        202,
        {
          queued: {
            id:
              queued.id,
            created:
              queued.created,
            deliveryKey:
              enqueue.deliveryKey,
          },
        },
      );
    } catch (error) {
      if (
        error instanceof
          AuthenticationError
      ) {
        return json(
          401,
          {
            error: {
              code:
                "AUTHENTICATION_REQUIRED",
              message:
                "Authentication required",
            },
          },
        );
      }

      if (
        error instanceof
          CaseAccessDeniedError
      ) {
        return json(
          403,
          {
            error: {
              code:
                "FORBIDDEN",
              message:
                "Access denied",
            },
          },
        );
      }

      return json(
        400,
        {
          error: {
            code:
              "COMMUNICATION_APPROVAL_REJECTED",
            message:
              error instanceof Error
                ? error.message
                : "Communication approval rejected",
          },
        },
      );
    }
  }
}
