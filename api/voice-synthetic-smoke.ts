import {
  handle as careOpsHandle,
} from "./care-ops.ts";

declare const process: {
  env: Readonly<
    Record<string, string | undefined>
  >;
};

const TENANT_ID = "tenant-demo";
const ACTOR_ID =
  "voice-preview-responder";

function requiredEnv(
  name: string,
): string {
  const value =
    process.env[name]?.trim();

  if (!value) {
    throw new Error(
      `missing environment variable ${name}`,
    );
  }

  return value;
}

async function json(
  response: Response,
): Promise<Record<string, unknown>> {
  const value =
    await response.json();

  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error(
      "unexpected JSON response",
    );
  }

  return value as
    Record<string, unknown>;
}

function safeResponse(
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

function fail(
  stage: string,
  status: number,
): Response {
  console.error(
    JSON.stringify({
      event:
        "synthetic_voice_smoke_failed",
      stage,
      status,
    }),
  );

  return safeResponse(
    502,
    {
      ok: false,
      stage,
      upstreamStatus:
        status,
    },
  );
}

export async function GET(
  request: Request,
): Promise<Response> {
  if (
    process.env.VERCEL_ENV ===
      "production"
  ) {
    return safeResponse(
      404,
      {
        error:
          "not_found",
      },
    );
  }

  try {
    const supabaseUrl =
      requiredEnv(
        "SUPABASE_URL",
      );
    const publishableKey =
      requiredEnv(
        "SUPABASE_PUBLISHABLE_KEY",
      );
    const secretKey =
      requiredEnv(
        "SUPABASE_SECRET_KEY",
      );

    const membershipUrl =
      new URL(
        "/rest/v1/care_tenant_memberships",
        supabaseUrl,
      );

    membershipUrl.searchParams.set(
      "tenant_id",
      `eq.${TENANT_ID}`,
    );
    membershipUrl.searchParams.set(
      "actor_id",
      `eq.${ACTOR_ID}`,
    );
    membershipUrl.searchParams.set(
      "active",
      "eq.true",
    );
    membershipUrl.searchParams.set(
      "select",
      "principal_id",
    );
    membershipUrl.searchParams.set(
      "limit",
      "1",
    );

    const membershipResponse =
      await fetch(
        membershipUrl,
        {
          headers: {
            apikey:
              secretKey,
            accept:
              "application/json",
          },
          cache:
            "no-store",
        },
      );

    if (
      !membershipResponse.ok
    ) {
      return fail(
        "membership_lookup",
        membershipResponse.status,
      );
    }

    const memberships =
      await membershipResponse
        .json() as unknown;

    if (
      !Array.isArray(
        memberships,
      ) ||
      memberships.length !== 1 ||
      !memberships[0] ||
      typeof memberships[0] !==
        "object" ||
      typeof (
        memberships[0] as
          Record<string, unknown>
      ).principal_id !==
        "string"
    ) {
      return fail(
        "membership_shape",
        500,
      );
    }

    const principalId =
      (
        memberships[0] as
          Record<string, unknown>
      ).principal_id as string;

    const userResponse =
      await fetch(
        new URL(
          `/auth/v1/admin/users/${encodeURIComponent(
            principalId,
          )}`,
          supabaseUrl,
        ),
        {
          headers: {
            apikey:
              secretKey,
            accept:
              "application/json",
          },
          cache:
            "no-store",
        },
      );

    if (
      !userResponse.ok
    ) {
      return fail(
        "admin_user_lookup",
        userResponse.status,
      );
    }

    const user =
      await json(
        userResponse,
      );
    const email =
      user.email;

    if (
      typeof email !==
        "string" ||
      !email
    ) {
      return fail(
        "admin_user_shape",
        500,
      );
    }

    const linkResponse =
      await fetch(
        new URL(
          "/auth/v1/admin/generate_link",
          supabaseUrl,
        ),
        {
          method:
            "POST",
          headers: {
            apikey:
              secretKey,
            accept:
              "application/json",
            "content-type":
              "application/json",
          },
          body:
            JSON.stringify({
              type:
                "magiclink",
              email,
            }),
          cache:
            "no-store",
        },
      );

    if (
      !linkResponse.ok
    ) {
      return fail(
        "generate_link",
        linkResponse.status,
      );
    }

    const link =
      await json(
        linkResponse,
      );
    const properties =
      (
        link.properties &&
        typeof link.properties ===
          "object" &&
        !Array.isArray(
          link.properties,
        )
      )
        ? (
            link.properties as
              Record<string, unknown>
          )
        : link;

    const hashedToken =
      properties.hashed_token;

    if (
      typeof hashedToken !==
        "string" ||
      !hashedToken
    ) {
      return fail(
        "generate_link_token",
        500,
      );
    }

    const verifyResponse =
      await fetch(
        new URL(
          "/auth/v1/verify",
          supabaseUrl,
        ),
        {
          method:
            "POST",
          headers: {
            apikey:
              publishableKey,
            accept:
              "application/json",
            "content-type":
              "application/json",
          },
          body:
            JSON.stringify({
              type:
                "email",
              token_hash:
                hashedToken,
            }),
          cache:
            "no-store",
        },
      );

    if (
      !verifyResponse.ok
    ) {
      return fail(
        "verify_magic_link",
        verifyResponse.status,
      );
    }

    const auth =
      await json(
        verifyResponse,
      );
    const accessToken =
      auth.access_token;

    if (
      typeof accessToken !==
        "string" ||
      !accessToken
    ) {
      return fail(
        "verify_shape",
        500,
      );
    }

    const voiceResponse =
      await careOpsHandle(
        new Request(
          "https://preview.synthetic.invalid/api/care-ops/tenants/tenant-demo/voice/session",
          {
            method:
              "POST",
            headers: {
              authorization:
                `Bearer ${accessToken}`,
              "content-type":
                "application/json",
            },
            body:
              JSON.stringify({
                locale:
                  "ja-JP",
              }),
          },
        ),
      );

    if (
      voiceResponse.status !==
        201
    ) {
      return fail(
        "voice_session",
        voiceResponse.status,
      );
    }

    const voice =
      await json(
        voiceResponse,
      );
    const session =
      voice.session;

    if (
      !session ||
      typeof session !==
        "object" ||
      Array.isArray(
        session,
      )
    ) {
      return fail(
        "voice_session_shape",
        500,
      );
    }

    const record =
      session as
        Record<string, unknown>;
    const websocketUrl =
      record.websocketUrl;

    if (
      typeof websocketUrl !==
        "string"
    ) {
      return fail(
        "voice_websocket_shape",
        500,
      );
    }

    const websocket =
      new URL(
        websocketUrl,
      );

    return safeResponse(
      200,
      {
        ok: true,
        syntheticAuth:
          "fresh-session",
        voiceStatus:
          201,
        provider:
          record.provider ??
          null,
        websocketScheme:
          websocket.protocol,
        sampleRateHz:
          (
            record.audio &&
            typeof record.audio ===
              "object" &&
            !Array.isArray(
              record.audio,
            )
          )
            ? (
                record.audio as
                  Record<string, unknown>
              ).sampleRateHz ??
              null
            : null,
        evidenceReceiptPresent:
          typeof voice.evidenceReceipt ===
            "string" &&
          voice.evidenceReceipt.length >
            20,
      },
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event:
          "synthetic_voice_smoke_exception",
        detail:
          error instanceof Error
            ? error.message
            : "unknown",
      }),
    );

    return safeResponse(
      500,
      {
        ok: false,
        stage:
          "exception",
      },
    );
  }
}
