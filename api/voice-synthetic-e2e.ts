import {
  handle as careOpsHandle,
} from "./care-ops.ts";

declare const process: {
  env: Readonly<Record<string, string | undefined>>;
};

const TENANT_ID = "tenant-demo";
const ACTOR_ID = "voice-preview-responder";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing environment variable ${name}`);
  return value;
}

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

function fail(stage: string, status: number): Response {
  console.error(JSON.stringify({
    event: "synthetic_voice_e2e_failed",
    stage,
    status,
  }));
  return response(502, {
    ok: false,
    stage,
    upstreamStatus: status,
  });
}

async function jsonRecord(res: Response): Promise<Record<string, unknown>> {
  const value = await res.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("unexpected JSON response");
  }
  return value as Record<string, unknown>;
}

function principalIdFromMembership(value: unknown): string | null {
  if (!Array.isArray(value) || value.length !== 1) return null;
  const row = value[0];
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const id = (row as Record<string, unknown>).principal_id;
  return typeof id === "string" && id ? id : null;
}

async function freshAccessToken(): Promise<string> {
  const supabaseUrl = requiredEnv("SUPABASE_URL");
  const publishableKey = requiredEnv("SUPABASE_PUBLISHABLE_KEY");
  const secretKey = requiredEnv("SUPABASE_SECRET_KEY");

  const membershipUrl = new URL("/rest/v1/care_tenant_memberships", supabaseUrl);
  membershipUrl.searchParams.set("tenant_id", `eq.${TENANT_ID}`);
  membershipUrl.searchParams.set("actor_id", `eq.${ACTOR_ID}`);
  membershipUrl.searchParams.set("active", "eq.true");
  membershipUrl.searchParams.set("select", "principal_id");
  membershipUrl.searchParams.set("limit", "1");

  const membershipResponse = await fetch(membershipUrl, {
    headers: {
      apikey: secretKey,
      accept: "application/json",
    },
    cache: "no-store",
  });

  if (!membershipResponse.ok) {
    throw new Error(`membership_lookup:${membershipResponse.status}`);
  }

  const principalId = principalIdFromMembership(
    await membershipResponse.json(),
  );
  if (!principalId) throw new Error("membership_shape:500");

  const userResponse = await fetch(
    new URL(
      `/auth/v1/admin/users/${encodeURIComponent(principalId)}`,
      supabaseUrl,
    ),
    {
      headers: {
        apikey: secretKey,
        accept: "application/json",
      },
      cache: "no-store",
    },
  );
  if (!userResponse.ok) {
    throw new Error(`admin_user_lookup:${userResponse.status}`);
  }

  const user = await jsonRecord(userResponse);
  const email = user.email;
  if (typeof email !== "string" || !email) {
    throw new Error("admin_user_shape:500");
  }

  const linkResponse = await fetch(
    new URL("/auth/v1/admin/generate_link", supabaseUrl),
    {
      method: "POST",
      headers: {
        apikey: secretKey,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type: "magiclink",
        email,
      }),
      cache: "no-store",
    },
  );
  if (!linkResponse.ok) {
    throw new Error(`generate_link:${linkResponse.status}`);
  }

  const link = await jsonRecord(linkResponse);
  const properties =
    link.properties &&
    typeof link.properties === "object" &&
    !Array.isArray(link.properties)
      ? link.properties as Record<string, unknown>
      : link;

  const hashedToken = properties.hashed_token;
  if (typeof hashedToken !== "string" || !hashedToken) {
    throw new Error("generate_link_token:500");
  }

  const verifyResponse = await fetch(
    new URL("/auth/v1/verify", supabaseUrl),
    {
      method: "POST",
      headers: {
        apikey: publishableKey,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type: "email",
        token_hash: hashedToken,
      }),
      cache: "no-store",
    },
  );
  if (!verifyResponse.ok) {
    throw new Error(`verify_magic_link:${verifyResponse.status}`);
  }

  const auth = await jsonRecord(verifyResponse);
  const accessToken = auth.access_token;
  if (typeof accessToken !== "string" || !accessToken) {
    throw new Error("verify_shape:500");
  }

  return accessToken;
}

async function call(
  accessToken: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<Response> {
  return await careOpsHandle(
    new Request(
      `https://preview.synthetic.invalid${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/json",
          ...(body === undefined
            ? {}
            : {
                "content-type": "application/json",
              }),
        },
        ...(body === undefined
          ? {}
          : {
              body: JSON.stringify(body),
            }),
      },
    ),
  );
}

async function okJson(
  accessToken: string,
  method: "GET" | "POST",
  path: string,
  expectedStatus: number,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const res = await call(accessToken, method, path, body);
  if (res.status !== expectedStatus) {
    throw new Error(`care_ops_${path}:${res.status}`);
  }
  return await jsonRecord(res);
}

function outboxTotal(health: Record<string, unknown>): number {
  const outbox = health.outbox;
  if (!outbox || typeof outbox !== "object" || Array.isArray(outbox)) {
    throw new Error("outbox_shape:500");
  }
  const counts = (outbox as Record<string, unknown>).counts;
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) {
    throw new Error("outbox_counts_shape:500");
  }
  const record = counts as Record<string, unknown>;
  const values = [
    record.pending,
    record.processing,
    record.failed,
    record.deadLetter,
    record.delivered,
  ];
  if (
    values.some(
      (value) =>
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 0,
    )
  ) {
    throw new Error("outbox_counts_invalid:500");
  }
  return (values as number[]).reduce((sum, value) => sum + value, 0);
}

export async function GET(): Promise<Response> {
  if (process.env.VERCEL_ENV === "production") {
    return response(404, { error: "not_found" });
  }

  try {
    const accessToken = await freshAccessToken();

    const session = await okJson(
      accessToken,
      "POST",
      `/api/care-ops/tenants/${TENANT_ID}/voice/session`,
      201,
      { locale: "ja-JP" },
    );

    const sessionValue = session.session;
    const receipt = session.evidenceReceipt;
    if (
      !sessionValue ||
      typeof sessionValue !== "object" ||
      Array.isArray(sessionValue) ||
      typeof receipt !== "string" ||
      !receipt
    ) {
      return fail("session_shape", 500);
    }

    const sessionRecord = sessionValue as Record<string, unknown>;
    const sessionId = sessionRecord.sessionId;
    if (typeof sessionId !== "string" || !sessionId) {
      return fail("session_id_shape", 500);
    }

    const healthPath =
      `/api/care-ops/tenants/${TENANT_ID}/voice/outbox/health`;
    const beforeHealth = await okJson(
      accessToken,
      "GET",
      healthPath,
      200,
    );
    const beforeTotal = outboxTotal(beforeHealth);

    const suffix = Date.now().toString(36);
    const caseId = `CASE-VOICE-E2E-${suffix}`;

    const plan = await okJson(
      accessToken,
      "POST",
      `/api/care-ops/tenants/${TENANT_ID}/voice/plan`,
      200,
      {
        caseId,
        subjectId: "subject-demo-e2e",
        locale: "ja-JP",
        transcript: {
          provider: "assemblyai",
          transcriptId: `${sessionId}:1`,
          text:
            "利用者が立ち上がった時にふらつきました。転倒はしていません。今は座っています。どうすればいいですか？",
          language: "ja",
          capturedAt: new Date().toISOString(),
        },
        evidenceReceipt: receipt,
      },
    );

    const planValue = plan.plan;
    const caseValue = plan.case;
    if (
      !planValue ||
      typeof planValue !== "object" ||
      Array.isArray(planValue) ||
      !caseValue ||
      typeof caseValue !== "object" ||
      Array.isArray(caseValue)
    ) {
      return fail("plan_shape", 500);
    }

    const drafts =
      (planValue as Record<string, unknown>).communicationDrafts;
    if (!Array.isArray(drafts) || drafts.length === 0) {
      return fail("communication_drafts", 500);
    }

    const queued: Array<Record<string, unknown>> = [];

    for (const draft of drafts) {
      const approved = await okJson(
        accessToken,
        "POST",
        `/api/care-ops/tenants/${TENANT_ID}/voice/communications/approve`,
        202,
        { draft },
      );

      const q = approved.queued;
      if (!q || typeof q !== "object" || Array.isArray(q)) {
        return fail("approved_shape", 500);
      }

      const qRecord = q as Record<string, unknown>;
      queued.push({
        id: qRecord.id ?? null,
        created: qRecord.created ?? null,
        deliveryKeyPresent:
          typeof qRecord.deliveryKey === "string" &&
          qRecord.deliveryKey.length > 0,
      });
    }

    const afterHealth = await okJson(
      accessToken,
      "GET",
      healthPath,
      200,
    );
    const afterTotal = outboxTotal(afterHealth);

    if (afterTotal < beforeTotal + queued.length) {
      return fail("outbox_did_not_increase", 500);
    }

    const c = caseValue as Record<string, unknown>;
    const p = planValue as Record<string, unknown>;
    const incident = p.incident;
    const guidance = p.guidance;

    return response(200, {
      ok: true,
      auth: "fresh-session",
      session: {
        provider: sessionRecord.provider ?? null,
        websocketScheme:
          typeof sessionRecord.websocketUrl === "string"
            ? new URL(sessionRecord.websocketUrl).protocol
            : null,
        evidenceReceiptPresent: true,
      },
      case: {
        id: c.id ?? null,
        status: c.status ?? null,
        version: c.version ?? null,
        created: c.created ?? null,
      },
      incident:
        incident &&
        typeof incident === "object" &&
        !Array.isArray(incident)
          ? {
              kind:
                (incident as Record<string, unknown>).kind ??
                null,
              urgency:
                (incident as Record<string, unknown>).urgency ??
                null,
            }
          : null,
      guidanceActions:
        guidance &&
        typeof guidance === "object" &&
        !Array.isArray(guidance) &&
        Array.isArray(
          (guidance as Record<string, unknown>).actions,
        )
          ? (
              (guidance as Record<string, unknown>).actions as unknown[]
            ).length
          : null,
      communications: queued.length,
      outbox: {
        beforeTotal,
        afterTotal,
        increasedBy: afterTotal - beforeTotal,
      },
    });
  } catch (error) {
    const detail =
      error instanceof Error
        ? error.message
        : "unknown";
    const match = /^([^:]+):(\d+)$/.exec(detail);
    if (match) {
      return fail(match[1]!, Number(match[2]));
    }

    console.error(JSON.stringify({
      event: "synthetic_voice_e2e_exception",
      detail,
    }));

    return response(500, {
      ok: false,
      stage: "exception",
    });
  }
}
