declare const process: {
  env: Readonly<
    Record<
      string,
      string | undefined
    >
  >;
};

const REQUIRED = [
  "ASSEMBLYAI_API_KEY",
  "CARE_OPS_VOICE_INTEGRITY_SECRET",
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "CARE_OPS_SLA_POLICIES_JSON",
] as const;

function configured(
  name:
    (typeof REQUIRED)[number],
): boolean {
  return Boolean(
    process.env[name]
      ?.trim(),
  );
}

export function previewHealth():
  Response {
  const preview =
    process.env.VERCEL_ENV !==
      "production";
  const ready =
    preview &&
    REQUIRED.every(
      configured,
    );

  return new Response(
    JSON.stringify({
      ready,
      mode:
        preview
          ? "preview"
          : "production-blocked",
      configuration:
        ready
          ? "present"
          : "incomplete",
      commit:
        process.env
          .VERCEL_GIT_COMMIT_SHA
          ?.slice(0, 12) ??
        null,
    }),
    {
      status:
        ready
          ? 200
          : 503,
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

export const GET =
  previewHealth;
export const HEAD =
  previewHealth;
