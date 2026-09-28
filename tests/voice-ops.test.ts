import test from "node:test";
import assert from "node:assert/strict";

import {
  DemoIndonesianGuidanceTranslator,
  RuleBasedDemoIncidentExtractor,
  approveCommunication,
  buildVoiceOpsPlan,
  normalizeAssemblyAiTurn,
  toCommunicationOutbox,
} from "../src/voice/index.ts";

const capturedAt = "2026-09-28T16:20:00+09:00";

test("final AssemblyAI turn becomes evidence and near-miss plan", async () => {
  const transcript = normalizeAssemblyAiTurn({
    transcriptId: "voice-001",
    text:
      "田中さんが立ち上がった時にふらつきました。転倒はしていません。今は座っています。こういう対応は初めてです。どうすればいいですか？",
    language: "ja",
    capturedAt,
    isFinal: true,
  });

  const result = await buildVoiceOpsPlan({
    tenantId: "tenant-demo",
    caseId: "CASE-VOICE-001",
    subjectId: "subject-demo-001",
    locale: "ja-JP",
    transcript,
    extractor: new RuleBasedDemoIncidentExtractor(),
    translator: new DemoIndonesianGuidanceTranslator(),
  });

  assert.equal(result.incident.kind, "near_miss");
  assert.equal(result.incident.needsGuidance, true);
  assert.equal(result.signal.sourceAdapter, "assemblyai-realtime");
  assert.equal(result.signal.type, "manual");
  assert.ok(
    result.guidance.actions.some(
      (item) => item.id === "observe-condition",
    ),
  );
  assert.equal(result.communicationDrafts.length, 2);
  assert.ok(
    result.communicationDrafts.every(
      (item) => item.requiresHumanApproval,
    ),
  );
});

test("Indonesian guidance preserves SOP action IDs", async () => {
  const transcript = normalizeAssemblyAiTurn({
    transcriptId: "voice-id-001",
    text:
      "Saya kurang paham bahasa Jepang. Pengguna hampir jatuh saat berdiri. Apa yang harus saya lakukan?",
    language: "id",
    capturedAt,
    isFinal: true,
  });

  const result = await buildVoiceOpsPlan({
    tenantId: "tenant-demo",
    caseId: "CASE-VOICE-002",
    subjectId: "subject-demo-002",
    locale: "id-ID",
    transcript,
    extractor: new RuleBasedDemoIncidentExtractor(),
    translator: new DemoIndonesianGuidanceTranslator(),
  });

  assert.equal(result.guidance.locale, "id-ID");
  assert.equal(result.guidance.heading, "Langkah berikutnya");
  assert.ok(
    result.guidance.actions.some(
      (item) =>
        item.id === "observe-condition" &&
        item.instruction.includes("Periksa"),
    ),
  );
});

test("communication requires explicit approval before outbox payload", () => {
  const draft = {
    id: "CASE-1:family:1",
    caseId: "CASE-1",
    audience: "family",
    channel: "message",
    body: "Synthetic family update",
    requiresHumanApproval: true,
  } as const;

  const approved = approveCommunication(
    draft,
    "responder-demo",
    "2026-09-28T16:25:00+09:00",
  );
  const queued = toCommunicationOutbox(
    "tenant-demo",
    approved,
  );

  assert.equal(queued.topic, "care_ops.communication");
  assert.equal(
    (queued.payload as { approvedBy: string }).approvedBy,
    "responder-demo",
  );
});

test("partial AssemblyAI turn is rejected", () => {
  assert.throws(
    () =>
      normalizeAssemblyAiTurn({
        transcriptId: "voice-partial",
        text: "partial",
        capturedAt,
        isFinal: false,
      }),
    /Only final AssemblyAI turns/,
  );
});
