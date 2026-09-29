import {
  CaseAccessDeniedError,
} from "../access/errors.ts";
import type {
  OperatorContextProjection,
} from "../application/capabilities.ts";
import type {
  AttentionSignal,
  CaseOpenResult,
} from "../application/types.ts";
import {
  AuthenticationError,
} from "../identity/types.ts";
import {
  assertCanUseVoiceOps,
  createCommunicationDrafts,
  VoiceOpsService,
  type VoiceTranscriptEvidence,
} from "../voice/index.ts";
import {
  readBoundedJson,
} from "./body.ts";

const SAFE_IDENTIFIER =
  /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_ACCESS_TOKEN_LENGTH =
  8 * 1024;
const DEFAULT_MAX_BODY_BYTES =
  32 * 1024;

export interface VoicePlanGateway {
  operatorContext(input: {
    accessToken: string;
    tenantId: string;
  }): Promise<OperatorContextProjection>;

  openFromSignal(input: {
    accessToken: string;
    tenantId: string;
    caseId: string;
    signal: AttentionSignal;
  }): Promise<CaseOpenResult>;
}

export interface VoicePlanHttpApiOptions {
  gateway: VoicePlanGateway;
  service?: VoiceOpsService;
  maxBodyBytes?: number;
}

function bearerToken(
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

function safeId(
  value: unknown,
  label: string,
): string {
  if (
    typeof value !== "string" ||
    !SAFE_IDENTIFIER.test(
      value,
    )
  ) {
    throw new Error(
      `${label} is invalid`,
    );
  }

  return value;
}

function locale(
  value: unknown,
): string {
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    value.length > 64 ||
    !/^[A-Za-z0-9-]+$/.test(
      value,
    )
  ) {
    throw new Error(
      "locale is invalid",
    );
  }

  return value;
}

function transcript(
  value: unknown,
): VoiceTranscriptEvidence {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error(
      "transcript is invalid",
    );
  }

  const record =
    value as Record<
      string,
      unknown
    >;

  if (
    Object.keys(record).some(
      (key) =>
        ![
          "provider",
          "transcriptId",
          "text",
          "language",
          "capturedAt",
        ].includes(key),
    ) ||
    record.provider !==
      "assemblyai" ||
    typeof record.transcriptId !==
      "string" ||
    typeof record.text !==
      "string" ||
    typeof record.language !==
      "string" ||
    typeof record.capturedAt !==
      "string"
  ) {
    throw new Error(
      "transcript is invalid",
    );
  }

  if (
    !record.transcriptId.trim() ||
    !record.text.trim() ||
    !Number.isFinite(
      Date.parse(
        record.capturedAt,
      ),
    )
  ) {
    throw new Error(
      "transcript is invalid",
    );
  }

  return {
    provider:
      "assemblyai",
    transcriptId:
      record.transcriptId.trim(),
    text:
      record.text.trim(),
    language:
      record.language.trim() ||
      "und",
    capturedAt:
      record.capturedAt,
  };
}

function tenantFromPath(
  request: Request,
): string | null {
  const parts =
    new URL(request.url)
      .pathname
      .split("/");

  if (
    parts.length !== 7 ||
    parts[0] !== "" ||
    parts[1] !== "api" ||
    parts[2] !== "care-ops" ||
    parts[3] !== "tenants" ||
    parts[5] !== "voice" ||
    parts[6] !== "plan"
  ) {
    return null;
  }

  try {
    return safeId(
      decodeURIComponent(
        parts[4]!,
      ),
      "tenantId",
    );
  } catch {
    return null;
  }
}

function response(
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

export class VoicePlanHttpApi {
  readonly #gateway:
    VoicePlanGateway;
  readonly #service:
    VoiceOpsService;
  readonly #maxBodyBytes:
    number;

  constructor(
    options:
      VoicePlanHttpApiOptions,
  ) {
    this.#gateway =
      options.gateway;
    this.#service =
      options.service ??
      new VoiceOpsService();
    this.#maxBodyBytes =
      options.maxBodyBytes ??
      DEFAULT_MAX_BODY_BYTES;
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
        return response(
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
        const result =
          response(
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
        result.headers.set(
          "allow",
          "POST",
        );
        return result;
      }

      const accessToken =
        bearerToken(
          request,
        );

      const operator =
        await this.#gateway
          .operatorContext({
            accessToken,
            tenantId,
          });

      assertCanUseVoiceOps(
        operator,
      );

      const raw =
        await readBoundedJson(
          request,
          this.#maxBodyBytes,
        );

      if (
        !raw ||
        typeof raw !==
          "object" ||
        Array.isArray(raw)
      ) {
        throw new Error(
          "request body must be an object",
        );
      }

      const body =
        raw as Record<
          string,
          unknown
        >;

      const allowed =
        [
          "caseId",
          "subjectId",
          "locale",
          "transcript",
        ];

      if (
        Object.keys(body).some(
          (key) =>
            !allowed.includes(
              key,
            ),
        )
      ) {
        throw new Error(
          "request body contains unexpected fields",
        );
      }

      const caseId =
        safeId(
          body.caseId,
          "caseId",
        );

      const plan =
        await this.#service
          .plan({
            tenantId,
            caseId,
            subjectId:
              safeId(
                body.subjectId,
                "subjectId",
              ),
            locale:
              locale(
                body.locale,
              ),
            transcript:
              transcript(
                body.transcript,
              ),
          });

      const opened =
        await this.#gateway
          .openFromSignal({
            accessToken,
            tenantId,
            caseId,
            signal:
              plan.signal,
          });

      const canonicalPlan = {
        ...plan,
        communicationDrafts:
          createCommunicationDrafts({
            caseId:
              opened.aggregate.id,
            incident:
              plan.incident,
          }),
      };

      return response(
        200,
        {
          plan:
            canonicalPlan,
          case: {
            id:
              opened.aggregate.id,
            version:
              opened.aggregate.version,
            status:
              opened.aggregate.status,
            created:
              opened.created,
          },
        },
      );
    } catch (error) {
      if (
        error instanceof
          AuthenticationError
      ) {
        return response(
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
        return response(
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

      return response(
        400,
        {
          error: {
            code:
              "VOICE_PLAN_REJECTED",
            message:
              error instanceof Error
                ? error.message
                : "Voice plan request rejected",
          },
        },
      );
    }
  }
}
