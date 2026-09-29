import type {
  IncidentExtractor,
  IncidentObservation,
  VoiceIncidentDraft,
  VoiceTranscriptEvidence,
} from "./types.ts";

function containsAny(
  value: string,
  patterns: readonly string[],
): boolean {
  const normalized = value.toLowerCase();
  return patterns.some((pattern) =>
    normalized.includes(pattern.toLowerCase())
  );
}

function observation(
  key: IncidentObservation["key"],
  label: string,
  state: IncidentObservation["state"],
  value?: string,
): IncidentObservation {
  return {
    key,
    label,
    state,
    ...(value ? { value } : {}),
  };
}

export class RuleBasedDemoIncidentExtractor
  implements IncidentExtractor
{
  async extract(input: {
    subjectId: string;
    transcript: VoiceTranscriptEvidence;
  }): Promise<VoiceIncidentDraft> {
    const text = input.transcript.text;

    const uncertainFall =
      containsAny(text, [
        "転倒したか",
        "転倒したのか",
        "転んだか",
        "倒れたか",
      ]) &&
      containsAny(text, [
        "確認できていません",
        "確認できない",
        "確認していません",
        "不明",
        "わからない",
        "分からない",
      ]);

    const noFall =
      !uncertainFall &&
      containsAny(text, [
      "転倒はしていません",
      "転倒していません",
      "転倒していない",
      "転倒してない",
      "転倒はありません",
      "転倒なし",
      "転倒には至っていません",
      "転倒には至らず",
      "転んでいません",
      "転んでいない",
      "転んでない",
      "did not fall",
      "didn't fall",
      "did not actually fall",
      "tidak jatuh",
      "hampir jatuh",
    ]);
    const fell =
      !uncertainFall &&
      containsAny(text, [
      "転倒しました",
      "転倒した",
      "転びました",
      "転んだ",
      "倒れました",
      "fell down",
      "did fall",
      "jatuh",
    ]) && !containsAny(text, [
      "tidak jatuh",
      "hampir jatuh",
    ]);

    const seated = containsAny(text, [
      "座っています",
      "座ってます",
      "座らせています",
      "椅子に座って",
      "腰掛けています",
      "着座",
      "sitting",
      "duduk",
    ]);

    const asksForHelp = containsAny(text, [
      "どうすれば",
      "どうしたら",
      "どう対応",
      "対応を教えて",
      "初めて",
      "わからない",
      "分からない",
      "what should i do",
      "what do i do",
      "apa yang harus",
      "tidak paham",
    ]);

    const urgentSignal = containsAny(text, [
      "意識がない",
      "意識ありません",
      "呼びかけに反応がない",
      "呼吸していない",
      "呼吸がない",
      "大量出血",
      "unconscious",
      "not breathing",
      "severe bleeding",
    ]);

    const kind =
      noFall && !fell ? "near_miss" : "incident";

    const urgency = urgentSignal
      ? "urgent"
      : kind === "incident"
        ? "attention"
        : "routine";

    const recommendedPriority = urgentSignal
      ? "critical"
      : kind === "incident"
        ? "high"
        : "normal";

    const observations: IncidentObservation[] = [
      observation(
        "fall_occurred",
        "転倒の有無",
        fell ? "confirmed" : noFall ? "denied" : "unknown",
      ),
      observation(
        "safe_position",
        "安全な姿勢",
        seated ? "confirmed" : "unknown",
        seated ? "着座" : undefined,
      ),
      observation("consciousness", "意識状態", "unknown"),
      observation("pain", "痛み", "unknown"),
      observation("injury", "外傷", "unknown"),
      observation(
        "dizziness_continues",
        "ふらつき継続",
        "unknown",
      ),
    ];

    const currentState = seated
      ? "現在は着座している"
      : "現在状態は追加確認が必要";

    return {
      kind,
      urgency,
      recommendedPriority,
      subjectId: input.subjectId,
      summary:
        kind === "near_miss"
          ? "立ち上がり等に伴う転倒未遂・ふらつきの可能性"
          : "転倒または状態変化を伴うインシデントの可能性",
      currentState,
      needsGuidance: asksForHelp,
      observations,
      evidence: input.transcript,
    };
  }
}
