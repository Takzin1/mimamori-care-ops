import test from "node:test";
import assert from "node:assert/strict";

import {
  createSupabaseCareOpsRuntime,
  type CaseSlaPolicy,
} from "../src/index.ts";

const minute = 60_000;

const policy: CaseSlaPolicy = {
  critical: {
    acknowledgeWithinMs: 2 * minute,
    assignWithinMs: 2 * minute,
    firstActionWithinMs: 2 * minute,
    handoffAcceptWithinMs: 2 * minute,
    completeWithinMs: 15 * minute,
  },
  high: {
    acknowledgeWithinMs: 5 * minute,
    assignWithinMs: 5 * minute,
    firstActionWithinMs: 5 * minute,
    handoffAcceptWithinMs: 5 * minute,
    completeWithinMs: 30 * minute,
  },
  normal: {
    acknowledgeWithinMs: 10 * minute,
    assignWithinMs: 5 * minute,
    firstActionWithinMs: 5 * minute,
    handoffAcceptWithinMs: 5 * minute,
    completeWithinMs: 60 * minute,
  },
  low: {
    acknowledgeWithinMs: 30 * minute,
    assignWithinMs: 30 * minute,
    firstActionWithinMs: 30 * minute,
    handoffAcceptWithinMs: 15 * minute,
    completeWithinMs: 180 * minute,
  },
};

function json(
  value: unknown,
): Response {
  return new Response(
    JSON.stringify(value),
    {
      headers: {
        "content-type":
          "application/json",
      },
    },
  );
}

test("voice-enabled runtime mounts authenticated live plan route", async () => {
  const fetchImpl =
    async (
      input:
        string | URL,
      init:
        RequestInit = {},
    ): Promise<Response> => {
      const url =
        new URL(
          input.toString(),
        );
      const headers =
        new Headers(
          init.headers,
        );

      if (
        url.pathname ===
          "/auth/v1/user"
      ) {
        assert.equal(
          headers.get(
            "authorization",
          ),
          "Bearer user-token",
        );

        return json({
          id:
            "principal-a",
        });
      }

      if (
        url.pathname ===
          "/rest/v1/care_tenant_memberships"
      ) {
        return json([
          {
            tenant_id:
              "provider-a",
            principal_id:
              "principal-a",
            actor_id:
              "responder-a",
            roles: [
              "responder",
            ],
            active: true,
          },
        ]);
      }

      throw new Error(
        "unexpected fetch",
      );
    };

  const app =
    createSupabaseCareOpsRuntime({
      supabaseUrl:
        "https://project.supabase.test",
      publishableKey:
        "publishable-key",
      serviceRoleKey:
        "service-secret",
      slaPolicies: {
        "provider-a":
          policy,
      },
      voiceSessionIssuer: {
        async issue() {
          return {
            provider:
              "assemblyai",
            sessionId:
              "session-demo",
            websocketUrl:
              "wss://voice.example.test/realtime",
            issuedAt:
              "2026-09-28T12:00:00Z",
            expiresAt:
              "2026-09-28T12:05:00Z",
            audio: {
              encoding:
                "pcm_s16le",
              sampleRateHz:
                16_000,
            },
          };
        },
      },
      fetchImpl,
      clock: () =>
        "2026-09-28T12:00:30Z",
    });

  const response =
    await app.handle(
      new Request(
        "https://care.example.test/api/care-ops/tenants/provider-a/voice/plan",
        {
          method: "POST",
          headers: {
            authorization:
              "Bearer user-token",
            "content-type":
              "application/json",
          },
          body: JSON.stringify({
            caseId:
              "CASE-LIVE-1",
            subjectId:
              "subject-demo-1",
            locale:
              "ja-JP",
            transcript: {
              provider:
                "assemblyai",
              transcriptId:
                "session-demo:1",
              text:
                "田中さんがふらつきました。転倒なし。どうすればいいですか？",
              language:
                "ja",
              capturedAt:
                "2026-09-28T12:00:10Z",
            },
          }),
        },
      ),
    );

  assert.equal(
    response.status,
    200,
  );

  const body =
    await response.json() as {
      plan: {
        incident: {
          kind: string;
        };
      };
    };

  assert.equal(
    body.plan.incident.kind,
    "near_miss",
  );
});
