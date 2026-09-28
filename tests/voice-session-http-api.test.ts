import test from "node:test";
import assert from "node:assert/strict";

import {
  VoiceSessionHttpApi,
} from "../src/http/index.ts";
import type {
  VoiceRealtimeSessionIssuer,
} from "../src/voice/index.ts";

const now =
  "2026-09-28T12:00:00Z";

const issuer:
  VoiceRealtimeSessionIssuer = {
    async issue(
      request,
    ) {
      assert.equal(
        request.actorId,
        "responder-demo",
      );

      return {
        provider:
          "assemblyai",
        sessionId:
          "session-001",
        websocketUrl:
          "wss://voice.example.test/realtime",
        issuedAt: now,
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
  };

test("authenticated operator can request voice session", async () => {
  const api =
    new VoiceSessionHttpApi({
      gateway: {
        async operatorContext(
          input,
        ) {
          assert.equal(
            input.accessToken,
            "token-demo",
          );
          assert.equal(
            input.tenantId,
            "tenant-demo",
          );

          return {
            tenantId:
              "tenant-demo",
            actorId:
              "responder-demo",
            roles: [
              "responder",
            ],
            queueVisibility:
              "responder",
          };
        },
      },
      issuer,
      now: () => now,
    });

  const response =
    await api.handle(
      new Request(
        "https://care.example.test/api/care-ops/tenants/tenant-demo/voice/session",
        {
          method: "POST",
          headers: {
            authorization:
              "Bearer token-demo",
            "content-type":
              "application/json",
          },
          body: JSON.stringify({
            locale:
              "ja-JP",
          }),
        },
      ),
    );

  assert.equal(
    response.status,
    201,
  );

  const body =
    await response.json() as {
      session: {
        provider: string;
        sessionId: string;
      };
    };

  assert.equal(
    body.session.provider,
    "assemblyai",
  );
  assert.equal(
    body.session.sessionId,
    "session-001",
  );
});

test("voice session endpoint rejects missing auth", async () => {
  const api =
    new VoiceSessionHttpApi({
      gateway: {
        async operatorContext() {
          throw new Error(
            "must not run",
          );
        },
      },
      issuer,
      now: () => now,
    });

  const response =
    await api.handle(
      new Request(
        "https://care.example.test/api/care-ops/tenants/tenant-demo/voice/session",
        {
          method: "POST",
          headers: {
            "content-type":
              "application/json",
          },
          body: JSON.stringify({
            locale:
              "ja-JP",
          }),
        },
      ),
    );

  assert.equal(
    response.status,
    401,
  );
});
