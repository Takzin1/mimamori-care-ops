import test from "node:test";
import assert from "node:assert/strict";

import {
  HmacVoiceIntegrity,
} from "../src/voice/index.ts";

const secret =
  "voice-integrity-test-secret-0123456789";

test("Voice session receipt binds tenant, actor, session and timing", async () => {
  const integrity =
    new HmacVoiceIntegrity(
      secret,
    );

  const receipt =
    await integrity
      .issueSessionReceipt({
        tenantId:
          "tenant-demo",
        actorId:
          "responder-demo",
        session: {
          provider:
            "assemblyai",
          sessionId:
            "session-001",
          websocketUrl:
            "wss://streaming.assemblyai.test/v3/ws?token=short-lived",
          issuedAt:
            "2026-09-29T09:00:00Z",
          expiresAt:
            "2026-09-29T09:05:00Z",
          audio: {
            encoding:
              "pcm_s16le",
            sampleRateHz:
              16000,
          },
        },
      });

  await integrity
    .verifySessionReceipt({
      receipt,
      tenantId:
        "tenant-demo",
      actorId:
        "responder-demo",
      transcript: {
        provider:
          "assemblyai",
        transcriptId:
          "session-001:3",
        text:
          "synthetic final turn",
        language:
          "ja",
        capturedAt:
          "2026-09-29T09:03:00Z",
      },
      now:
        "2026-09-29T09:03:01Z",
    });

  await assert.rejects(
    () =>
      integrity
        .verifySessionReceipt({
          receipt,
          tenantId:
            "tenant-other",
          actorId:
            "responder-demo",
          transcript: {
            provider:
              "assemblyai",
            transcriptId:
              "session-001:3",
            text:
              "synthetic final turn",
            language:
              "ja",
            capturedAt:
              "2026-09-29T09:03:00Z",
          },
          now:
            "2026-09-29T09:03:01Z",
        }),
    /identity mismatch/,
  );

  await assert.rejects(
    () =>
      integrity
        .verifySessionReceipt({
          receipt,
          tenantId:
            "tenant-demo",
          actorId:
            "responder-demo",
          transcript: {
            provider:
              "assemblyai",
            transcriptId:
              "forged-session:1",
            text:
              "synthetic final turn",
            language:
              "ja",
            capturedAt:
              "2026-09-29T09:03:00Z",
          },
          now:
            "2026-09-29T09:03:01Z",
        }),
    /not bound/,
  );
});

test("signed communication Draft rejects body and tenant tampering", async () => {
  const integrity =
    new HmacVoiceIntegrity(
      secret,
    );
  const signed =
    await integrity
      .signCommunicationDraft(
        "tenant-demo",
        {
          id:
            "CASE-1:family:1",
          caseId:
            "CASE-1",
          audience:
            "family",
          channel:
            "message",
          body:
            "Synthetic family update",
          requiresHumanApproval:
            true,
        },
      );

  const verified =
    await integrity
      .verifyCommunicationDraft(
        "tenant-demo",
        signed,
      );

  assert.equal(
    verified.body,
    "Synthetic family update",
  );

  await assert.rejects(
    () =>
      integrity
        .verifyCommunicationDraft(
          "tenant-demo",
          {
            ...signed,
            body:
              "Tampered body",
          },
        ),
    /integrity verification failed/,
  );

  await assert.rejects(
    () =>
      integrity
        .verifyCommunicationDraft(
          "tenant-other",
          signed,
        ),
    /integrity verification failed/,
  );
});
