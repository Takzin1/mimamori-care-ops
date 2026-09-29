import test from "node:test";
import assert from "node:assert/strict";

import {
  previewHealth,
} from "../api/health.ts";

const keys = [
  "ASSEMBLYAI_API_KEY",
  "CARE_OPS_VOICE_INTEGRITY_SECRET",
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "CARE_OPS_SLA_POLICIES_JSON",
  "VERCEL_ENV",
  "VERCEL_GIT_COMMIT_SHA",
] as const;

function restore(
  snapshot:
    Record<string, string | undefined>,
): void {
  for (const key of keys) {
    const value =
      snapshot[key];

    if (
      value === undefined
    ) {
      delete process.env[key];
    } else {
      process.env[key] =
        value;
    }
  }
}

test("Vercel Preview health is ready only when all server configuration is present", async () => {
  const snapshot =
    Object.fromEntries(
      keys.map(
        (key) => [
          key,
          process.env[key],
        ],
      ),
    ) as Record<
      string,
      string | undefined
    >;

  try {
    process.env.VERCEL_ENV =
      "preview";
    process.env.VERCEL_GIT_COMMIT_SHA =
      "1234567890abcdef";
    process.env.ASSEMBLYAI_API_KEY =
      "assembly-secret";
    process.env.CARE_OPS_VOICE_INTEGRITY_SECRET =
      "voice-integrity-test-secret-0123456789";
    process.env.SUPABASE_URL =
      "https://project.supabase.test";
    process.env.SUPABASE_PUBLISHABLE_KEY =
      "publishable";
    process.env.SUPABASE_SERVICE_ROLE_KEY =
      "service-role";
    process.env.CARE_OPS_SLA_POLICIES_JSON =
      "{}";

    const response =
      previewHealth();

    assert.equal(
      response.status,
      200,
    );

    const body =
      await response.json() as {
        ready: boolean;
        mode: string;
        configuration: string;
        commit: string | null;
      };

    assert.deepEqual(
      body,
      {
        ready: true,
        mode: "preview",
        configuration:
          "present",
        commit:
          "1234567890ab",
      },
    );
  } finally {
    restore(snapshot);
  }
});

test("Vercel Preview health fails closed when configuration is incomplete", async () => {
  const snapshot =
    Object.fromEntries(
      keys.map(
        (key) => [
          key,
          process.env[key],
        ],
      ),
    ) as Record<
      string,
      string | undefined
    >;

  try {
    process.env.VERCEL_ENV =
      "preview";
    delete process.env
      .ASSEMBLYAI_API_KEY;
    process.env.CARE_OPS_VOICE_INTEGRITY_SECRET =
      "voice-integrity-test-secret-0123456789";
    process.env.SUPABASE_URL =
      "https://project.supabase.test";
    process.env.SUPABASE_PUBLISHABLE_KEY =
      "publishable";
    process.env.SUPABASE_SERVICE_ROLE_KEY =
      "service-role";
    process.env.CARE_OPS_SLA_POLICIES_JSON =
      "{}";

    const response =
      previewHealth();

    assert.equal(
      response.status,
      503,
    );

    const body =
      await response.json() as {
        ready: boolean;
        mode: string;
        configuration: string;
      };

    assert.equal(
      body.ready,
      false,
    );
    assert.equal(
      body.configuration,
      "incomplete",
    );
  } finally {
    restore(snapshot);
  }
});

test("Vercel health never reports production as Voice-ready", async () => {
  const snapshot =
    Object.fromEntries(
      keys.map(
        (key) => [
          key,
          process.env[key],
        ],
      ),
    ) as Record<
      string,
      string | undefined
    >;

  try {
    process.env.VERCEL_ENV =
      "production";

    for (
      const key of
        keys.slice(0, 6)
    ) {
      process.env[key] =
        "configured";
    }

    const response =
      previewHealth();

    assert.equal(
      response.status,
      503,
    );

    const body =
      await response.json() as {
        ready: boolean;
        mode: string;
      };

    assert.equal(
      body.ready,
      false,
    );
    assert.equal(
      body.mode,
      "production-blocked",
    );
  } finally {
    restore(snapshot);
  }
});
