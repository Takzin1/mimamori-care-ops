import type {
  ObservationState,
  SituationUnderstanding,
  SituationUnderstandingProvider,
  VoiceTranscriptEvidence,
} from "./types.ts";

const MAX_SUMMARY_LENGTH = 240;
const MAX_CLARIFICATION_LENGTH = 240;
const MAX_CLARIFICATIONS = 6;

function containsAny(
  value: string,
  patterns: readonly string[],
): boolean {
  const normalized =
    value.toLowerCase();

  return patterns.some(
    (pattern) =>
      normalized.includes(
        pattern.toLowerCase(),
      ),
  );
}

const NO_FALL_PATTERNS = [
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
] as const;

const EXPLICIT_FALL_PATTERNS = [
  "転倒しました",
  "転倒した",
  "転倒しています",
  "転倒している",
  "転びました",
  "転んだ",
  "転んでいます",
  "fell down",
  "did fall",
  "jatuh",
] as const;

const COLLAPSE_PATTERNS = [
  "倒れています",
  "倒れている",
  "倒れました",
  "倒れた",
  "倒れ込",
  "collapse",
  "collapsed",
] as const;

const FEVER_PATTERNS = [
  "高熱",
  "発熱",
  "熱が出",
  "熱を出",
  "fever",
  "demam",
] as const;

const NEAR_MISS_PATTERNS = [
  "ふらつき",
  "ふらついた",
  "よろけ",
  "almost fell",
  "hampir jatuh",
] as const;

function safeText(
  value: unknown,
  label: string,
  maxLength: number,
): string {
  if (
    typeof value !== "string"
  ) {
    throw new Error(
      `Situation understanding ${label} must be text`,
    );
  }

  const normalized =
    value.trim();

  if (
    !normalized ||
    normalized.length >
      maxLength
  ) {
    throw new Error(
      `Situation understanding ${label} is invalid`,
    );
  }

  return normalized;
}

function state(
  value: unknown,
  label: string,
): ObservationState {
  if (
    value !== "confirmed" &&
    value !== "denied" &&
    value !== "unknown"
  ) {
    throw new Error(
      `Situation understanding ${label} is invalid`,
    );
  }

  return value;
}

function explicitFallState(
  text: string,
): ObservationState {
  const uncertain =
    containsAny(
      text,
      [
        "転倒したか",
        "転倒したのか",
        "転んだか",
        "倒れたか",
      ],
    ) &&
    containsAny(
      text,
      [
        "確認できていません",
        "確認できない",
        "確認していません",
        "不明",
        "わからない",
        "分からない",
      ],
    );

  if (uncertain) {
    return "unknown";
  }

  if (
    containsAny(
      text,
      NO_FALL_PATTERNS,
    )
  ) {
    return "denied";
  }

  if (
    containsAny(
      text,
      EXPLICIT_FALL_PATTERNS,
    )
  ) {
    return "confirmed";
  }

  return "unknown";
}

function collapseState(
  text: string,
): ObservationState {
  return containsAny(
    text,
    COLLAPSE_PATTERNS,
  )
    ? "confirmed"
    : "unknown";
}

function feverState(
  text: string,
): ObservationState {
  return containsAny(
    text,
    FEVER_PATTERNS,
  )
    ? "confirmed"
    : "unknown";
}

function eventSummary(
  input: {
    fall: ObservationState;
    collapse: ObservationState;
    fever: ObservationState;
    nearMiss: boolean;
  },
): string {
  if (
    input.fall ===
      "confirmed"
  ) {
    return "転倒を伴うインシデントの可能性";
  }

  if (
    input.collapse ===
      "confirmed" &&
    input.fever ===
      "confirmed"
  ) {
    return "発熱を伴う体調変化・倒れ込みの可能性";
  }

  if (
    input.collapse ===
      "confirmed"
  ) {
    return "倒れ込みを伴う状態変化の可能性";
  }

  if (
    input.fever ===
      "confirmed"
  ) {
    return "発熱を伴う状態変化の可能性";
  }

  if (
    input.fall ===
      "denied" &&
    input.nearMiss
  ) {
    return "立ち上がり等に伴う転倒未遂・ふらつきの可能性";
  }

  return "状態変化を伴うインシデントの可能性";
}

function deriveRuleBasedSituation(
  transcript:
    VoiceTranscriptEvidence,
): SituationUnderstanding {
  const text =
    transcript.text;
  const fall =
    explicitFallState(
      text,
    );
  const collapse =
    collapseState(
      text,
    );
  const fever =
    feverState(
      text,
    );
  const nearMiss =
    containsAny(
      text,
      NEAR_MISS_PATTERNS,
    );
  const clarificationQuestions:
    string[] = [];

  if (
    collapse ===
      "confirmed" &&
    fall ===
      "unknown"
  ) {
    clarificationQuestions.push(
      "転倒したのか、体調不良などで倒れ込んだのか",
    );
  }

  return {
    summary:
      eventSummary({
        fall,
        collapse,
        fever,
        nearMiss,
      }),
    fall,
    collapse,
    fever,
    needsClarification:
      clarificationQuestions
        .length > 0,
    clarificationQuestions,
  };
}

export class RuleBasedSituationUnderstandingProvider
implements SituationUnderstandingProvider {
  async understand(input: {
    subjectId: string;
    transcript:
      VoiceTranscriptEvidence;
  }): Promise<SituationUnderstanding> {
    return deriveRuleBasedSituation(
      input.transcript,
    );
  }
}

export interface SituationUnderstandingTransportRequest {
  text: string;
  language: string;
  instructions: readonly string[];
}

export interface SituationUnderstandingTransport {
  analyze(
    request:
      SituationUnderstandingTransportRequest,
  ): Promise<unknown>;
}

export interface GuardedApiSituationUnderstandingProviderOptions {
  transport:
    SituationUnderstandingTransport;
  fallback?:
    SituationUnderstandingProvider;
}

function object(
  value: unknown,
): Record<string, unknown> {
  if (
    !value ||
    typeof value !==
      "object" ||
    Array.isArray(value)
  ) {
    throw new Error(
      "Situation understanding response must be an object",
    );
  }

  return value as
    Record<string, unknown>;
}

function parseClarifications(
  value: unknown,
): string[] {
  if (
    !Array.isArray(value) ||
    value.length >
      MAX_CLARIFICATIONS
  ) {
    throw new Error(
      "Situation understanding clarificationQuestions is invalid",
    );
  }

  return value.map(
    (item, index) =>
      safeText(
        item,
        `clarificationQuestions[${index}]`,
        MAX_CLARIFICATION_LENGTH,
      ),
  );
}

function guardedFact(
  proposed:
    ObservationState,
  deterministic:
    ObservationState,
): ObservationState {
  if (
    deterministic !==
      "unknown"
  ) {
    return deterministic;
  }

  return proposed ===
      "denied"
    ? "unknown"
    : proposed ===
        "confirmed"
      ? "unknown"
      : "unknown";
}

export class GuardedApiSituationUnderstandingProvider
implements SituationUnderstandingProvider {
  readonly #transport:
    SituationUnderstandingTransport;
  readonly #fallback:
    SituationUnderstandingProvider;

  constructor(
    options:
      GuardedApiSituationUnderstandingProviderOptions,
  ) {
    this.#transport =
      options.transport;
    this.#fallback =
      options.fallback ??
      new RuleBasedSituationUnderstandingProvider();
  }

  async understand(input: {
    subjectId: string;
    transcript:
      VoiceTranscriptEvidence;
  }): Promise<SituationUnderstanding> {
    const deterministic =
      deriveRuleBasedSituation(
        input.transcript,
      );

    try {
      const response =
        object(
          await this.#transport
            .analyze({
              text:
                input.transcript
                  .text,
              language:
                input.transcript
                  .language,
              instructions: [
                "Preserve the raw transcript as evidence; do not rewrite it.",
                "Distinguish an explicit fall/転倒 from a collapse/倒れ込み.",
                "Do not infer a fall from the Japanese verb 倒れる alone.",
                "Do not diagnose, assign severity, choose an SOP, or recommend treatment.",
                "Use only confirmed, denied, or unknown for critical facts.",
                "When meaning is ambiguous, return unknown and add a clarification question.",
              ],
            }),
        );

      const proposedFall =
        state(
          response.fall,
          "fall",
        );
      const proposedCollapse =
        state(
          response.collapse,
          "collapse",
        );
      const proposedFever =
        state(
          response.fever,
          "fever",
        );
      const summary =
        safeText(
          response.summary,
          "summary",
          MAX_SUMMARY_LENGTH,
        );
      const clarificationQuestions =
        parseClarifications(
          response
            .clarificationQuestions,
        );

      const fall =
        guardedFact(
          proposedFall,
          deterministic.fall,
        );
      const collapse =
        guardedFact(
          proposedCollapse,
          deterministic.collapse,
        );
      const fever =
        guardedFact(
          proposedFever,
          deterministic.fever,
        );

      return {
        summary,
        fall,
        collapse,
        fever,
        needsClarification:
          clarificationQuestions
            .length > 0 ||
          (
            collapse ===
              "confirmed" &&
            fall ===
              "unknown"
          ),
        clarificationQuestions:
          clarificationQuestions
            .length > 0
            ? clarificationQuestions
            : deterministic
                .clarificationQuestions,
      };
    } catch {
      return this.#fallback
        .understand(input);
    }
  }
}
