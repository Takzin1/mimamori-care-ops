import test from "node:test";
import assert from "node:assert/strict";

import {
  VoicePlanHttpApi,
} from "../src/http/index.ts";

test("authenticated voice plan endpoint turns final transcript into incident guidance", async () => {
  const api =
    new VoicePlanHttpApi({
      gateway: {
        async operatorContext(
          input,
        ) {
          assert.equal(
            input.accessToken,
            "token-demo",
          );

          return {
            tenantId:
              input.tenantId,
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
    });

  const response =
    await api.handle(
      new Request(
        "https://care.example.test/api/care-ops/tenants/tenant-demo/voice/plan",
        {
          method: "POST",
          headers: {
            authorization:
              "Bearer token-demo",
            "content-type":
              "application/json",
          },
          body: JSON.stringify({
            caseId:
              "CASE-VOICE-DEMO",
            subjectId:
              "subject-demo-001",
            locale:
              "ja-JP",
            transcript: {
              provider:
                "assemblyai",
              transcriptId:
                "session-1:3",
              text:
                "田中さんが立ち上がった時にふらつきました。転倒はしていません。今は座っています。どうすればいいですか？",
              language:
                "ja",
              capturedAt:
                "2026-09-28T12:00:00Z",
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
        guidance: {
          actions: unknown[];
        };
        communicationDrafts:
          unknown[];
      };
    };

  assert.equal(
    body.plan.incident.kind,
    "near_miss",
  );
  assert.ok(
    body.plan.guidance
      .actions.length >= 2,
  );
  assert.equal(
    body.plan
      .communicationDrafts
      .length,
    2,
  );
});
