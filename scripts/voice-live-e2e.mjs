const required = (name) => {
  const value =
    process.env[name]?.trim();

  if (!value) {
    throw new Error(
      `${name} is required`,
    );
  }

  return value;
};

function requireOrigin(
  value,
) {
  const url =
    new URL(value);

  if (
    url.protocol !== "https:" &&
    ![
      "localhost",
      "127.0.0.1",
    ].includes(url.hostname)
  ) {
    throw new Error(
      "CARE_OPS_API_BASE must use https outside localhost",
    );
  }

  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (
      url.pathname &&
      url.pathname !== "/"
    )
  ) {
    throw new Error(
      "CARE_OPS_API_BASE must be an origin",
    );
  }

  return url.origin;
}

function requireIdentifier(
  value,
  label,
) {
  const normalized =
    value.trim();

  if (
    !/^[A-Za-z0-9._:-]{1,128}$/.test(
      normalized,
    )
  ) {
    throw new Error(
      `${label} is invalid`,
    );
  }

  return normalized;
}

const apiBase =
  requireOrigin(
    required(
      "CARE_OPS_API_BASE",
    ),
  );
const tenantId =
  requireIdentifier(
    required(
      "CARE_OPS_TENANT_ID",
    ),
    "CARE_OPS_TENANT_ID",
  );
const accessToken =
  required(
    "CARE_OPS_ACCESS_TOKEN",
  );

if (
  accessToken.length >
    8 * 1024 ||
  /[\s,]/.test(
    accessToken,
  )
) {
  throw new Error(
    "CARE_OPS_ACCESS_TOKEN is malformed",
  );
}

const locale =
  (
    process.env
      .CARE_OPS_VOICE_LOCALE ??
    "ja-JP"
  ).trim();

if (
  locale.length < 2 ||
  locale.length > 64 ||
  !/^[A-Za-z0-9-]+$/.test(
    locale,
  )
) {
  throw new Error(
    "CARE_OPS_VOICE_LOCALE is invalid",
  );
}

const protectionBypass =
  process.env
    .VERCEL_AUTOMATION_BYPASS_SECRET
    ?.trim();

if (
  protectionBypass &&
  (
    protectionBypass.length >
      8 * 1024 ||
    /[\r\n]/.test(
      protectionBypass,
    )
  )
) {
  throw new Error(
    "VERCEL_AUTOMATION_BYPASS_SECRET is malformed",
  );
}

async function jsonPost(
  path,
  body,
  expectedStatus,
) {
  const response =
    await fetch(
      new URL(
        path,
        apiBase,
      ),
      {
        method:
          "POST",
        headers: {
          accept:
            "application/json",
          authorization:
            `Bearer ${accessToken}`,
          "content-type":
            "application/json",
          ...(protectionBypass
            ? {
                "x-vercel-protection-bypass":
                  protectionBypass,
              }
            : {}),
        },
        body:
          JSON.stringify(
            body,
          ),
        cache:
          "no-store",
        credentials:
          "omit",
        redirect:
          "error",
        referrerPolicy:
          "no-referrer",
      },
    );

  const type =
    response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();

  if (
    type !==
      "application/json"
  ) {
    throw new Error(
      `Care Ops returned non-JSON HTTP ${response.status}`,
    );
  }

  const value =
    await response.json();

  if (
    response.status !==
      expectedStatus
  ) {
    throw new Error(
      `Care Ops HTTP ${response.status}: ${value?.error?.code ?? "unknown"}`,
    );
  }

  return value;
}

const suffix =
  Date.now()
    .toString(36);
const caseId =
  `CASE-VOICE-E2E-${suffix}`;
const transcriptId =
  `voice-e2e-${suffix}`;
const subjectId =
  "subject-demo-e2e";
const capturedAt =
  new Date()
    .toISOString();

const planResult =
  await jsonPost(
    `/api/care-ops/tenants/${encodeURIComponent(tenantId)}/voice/plan`,
    {
      caseId,
      subjectId,
      locale,
      transcript: {
        provider:
          "assemblyai",
        transcriptId,
        text:
          "利用者が立ち上がった時にふらつきました。転倒はしていません。今は座っています。どうすればいいですか？",
        language:
          "ja",
        capturedAt,
      },
    },
    200,
  );

if (
  planResult?.case?.id !==
    caseId ||
  typeof planResult?.case?.version !==
    "number" ||
  !planResult?.plan ||
  !Array.isArray(
    planResult.plan
      .communicationDrafts,
  ) ||
  planResult.plan
    .communicationDrafts
    .length === 0
) {
  throw new Error(
    "Voice plan response shape is invalid",
  );
}

const queued = [];

for (
  const draft of
    planResult.plan
      .communicationDrafts
) {
  const approved =
    await jsonPost(
      `/api/care-ops/tenants/${encodeURIComponent(tenantId)}/voice/communications/approve`,
      {
        draft,
      },
      202,
    );

  if (
    !Number.isInteger(
      approved?.queued?.id,
    ) ||
    typeof approved?.queued
      ?.deliveryKey !==
      "string"
  ) {
    throw new Error(
      "Communication approval response shape is invalid",
    );
  }

  queued.push({
    audience:
      draft.audience,
    outboxId:
      approved.queued.id,
    created:
      approved.queued
        .created,
  });
}

console.log(
  JSON.stringify(
    {
      ok: true,
      case: {
        id:
          planResult.case.id,
        version:
          planResult.case.version,
        status:
          planResult.case.status,
        created:
          planResult.case.created,
      },
      incident: {
        kind:
          planResult.plan
            .incident?.kind,
        urgency:
          planResult.plan
            .incident?.urgency,
      },
      guidanceActions:
        Array.isArray(
          planResult.plan
            .guidance?.actions,
        )
          ? planResult.plan
              .guidance.actions
              .length
          : null,
      communications:
        queued,
    },
    null,
    2,
  ),
);
