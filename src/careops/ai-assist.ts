import type { CaseAggregate } from "../core/types.ts";
import type {
  AiDraftContent,
  AiDraftFact,
  AiDraftKind,
} from "./types.ts";

/**
 * Human-in-the-Loop AI assistance.
 *
 * AI output is only ever stored as a *draft* that a human reviews. It is
 * never written into the Case as fact automatically, never completes,
 * closes, assigns or accepts anything, and never makes a medical,
 * treatment or emergency-transport decision.
 */

export interface AiSourceText {
  /** Stable reference, e.g. "signal:<id>" or "event:<sequence>". */
  ref: string;
  label: string;
  text: string;
}

export interface AiDraftRequest {
  kind: AiDraftKind;
  aggregate: CaseAggregate;
  sources: AiSourceText[];
}

export interface AiProviderOutput {
  text: string;
  facts: Array<Omit<AiDraftFact, "verified">>;
  missing: string[];
  uncertain: string[];
}

export interface AiDraftProvider {
  readonly name: string;
  readonly model: string;
  generate(request: AiDraftRequest, signal: AbortSignal): Promise<AiProviderOutput>;
}

export class AiProviderUnavailableError extends Error {
  readonly code = "AI_PROVIDER_UNAVAILABLE";
  constructor(message = "AI provider is not configured") {
    super(message);
    this.name = "AiProviderUnavailableError";
  }
}

/** Used when AI is disabled. Basic CareOps never depends on it. */
export class DisabledAiDraftProvider implements AiDraftProvider {
  readonly name = "disabled";
  readonly model = "none";
  async generate(): Promise<AiProviderOutput> {
    throw new AiProviderUnavailableError();
  }
}

/* ------------------------------------------------------------------ */
/* Guards                                                               */
/* ------------------------------------------------------------------ */

const CLINICAL_ASSERTION_PATTERNS: readonly RegExp[] = [
  /診断/,
  /疑い(が|あり|がある)/,
  /(投与|投薬|処方)(する|すべき|してください)/,
  /(救急)?搬送(すべき|が必要|してください)/,
  /(治療|処置)(すべき|が必要|してください)/,
  /重症|軽症/,
];

/**
 * Flags medical-judgement language. The draft is still shown to the
 * reviewer, but with a prominent warning; the system itself never acts
 * on such statements.
 */
export function clinicalAssertionWarnings(text: string): string[] {
  return CLINICAL_ASSERTION_PATTERNS.some((pattern) => pattern.test(text))
    ? ["医療的判断（診断・治療・搬送）に関わる表現が含まれています。AIはこれらを判断しません。権限を持つ職員・医療職が判断してください。"]
    : [];
}

/**
 * A fact is "verified" only when its quote occurs literally in the
 * referenced source text. Anything else is shown as unverified and must
 * not be recorded as fact without an explicit human edit.
 */
export function verifyFacts(
  facts: AiProviderOutput["facts"],
  sources: readonly AiSourceText[],
): AiDraftFact[] {
  const byRef = new Map(sources.map((source) => [source.ref, source.text]));
  return facts.slice(0, 50).map((fact) => {
    const text = byRef.get(fact.sourceRef);
    const quote = fact.quote.trim();
    return {
      label: fact.label.slice(0, 64),
      value: fact.value.slice(0, 500),
      quote: quote.slice(0, 500),
      sourceRef: fact.sourceRef,
      verified: Boolean(text && quote && text.includes(quote)),
    };
  });
}

export function finalizeDraftContent(
  output: AiProviderOutput,
  sources: readonly AiSourceText[],
): AiDraftContent {
  const facts = verifyFacts(output.facts, sources);
  const warnings = clinicalAssertionWarnings(
    [output.text, ...facts.map((fact) => fact.value)].join("\n"),
  );
  if (facts.some((fact) => !fact.verified)) {
    warnings.push("原文で根拠を確認できない項目があります（未検証）。事実として記録しないでください。");
  }
  return {
    text: output.text.slice(0, 8000),
    facts,
    missing: output.missing.slice(0, 20).map((item) => item.slice(0, 200)),
    uncertain: output.uncertain.slice(0, 20).map((item) => item.slice(0, 300)),
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/* Deterministic local provider                                         */
/* ------------------------------------------------------------------ */

const FACT_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "時刻", pattern: /\d{1,2}(:\d{2}|時(\d{1,2}分)?)/ },
  { label: "バイタル", pattern: /(体温|血圧|脈拍|SpO2|酸素飽和度|呼吸数)/ },
  { label: "転倒", pattern: /転倒|転落|ころん|転んだ/ },
  { label: "体調", pattern: /発熱|熱|嘔吐|吐き気|痛み|痛い|しびれ|めまい|咳|息苦し/ },
  { label: "意識・反応", pattern: /意識|反応|応答|返事|会話/ },
  { label: "食事・水分", pattern: /食事|水分|飲水|食べ/ },
  { label: "服薬", pattern: /服薬|薬/ },
  { label: "家族・関係者", pattern: /家族|息子|娘|ご家族|ケアマネ|主治医|連絡/ },
  { label: "訪問・対応", pattern: /訪問|居室|巡回|対応/ },
];

const UNCERTAIN_PATTERN = /かもしれ|と思|不明|未確認|らしい|ようだ|ようです|？|\?|わからな/;

function sentences(text: string): string[] {
  return text
    .split(/(?<=[。！？!?\n])/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export class RuleBasedDraftProvider implements AiDraftProvider {
  readonly name = "local-rules";
  readonly model = "careops-extract-v1";

  async generate(request: AiDraftRequest, signal: AbortSignal): Promise<AiProviderOutput> {
    if (signal.aborted) throw new Error("AI generation aborted");
    const facts: AiProviderOutput["facts"] = [];
    const uncertain: string[] = [];
    const seen = new Set<string>();

    for (const source of request.sources) {
      for (const sentence of sentences(source.text)) {
        if (UNCERTAIN_PATTERN.test(sentence)) {
          uncertain.push(`${source.label}: ${sentence}`);
        }
        for (const { label, pattern } of FACT_PATTERNS) {
          if (!pattern.test(sentence)) continue;
          const key = `${label}\u0000${sentence}`;
          if (seen.has(key)) continue;
          seen.add(key);
          facts.push({ label, value: sentence, quote: sentence, sourceRef: source.ref });
          break;
        }
      }
    }

    const aggregate = request.aggregate;
    const missing: string[] = [];
    if (!aggregate.lastCheckedAt) missing.push("本人の状態確認（様子観察）の記録がありません");
    if (!aggregate.priorityRationale) missing.push("優先度の設定根拠が未入力です");
    if (!aggregate.assigneeId) missing.push("担当者が未割当です");
    if (!facts.some((fact) => fact.label === "家族・関係者")) missing.push("家族・関係者への連絡有無の記録がありません");
    if (!facts.some((fact) => fact.label === "時刻")) missing.push("事象の発生時刻が原文から特定できません");

    const factLines = facts.slice(0, 12).map((fact) => `・[${fact.label}] 「${fact.quote}」`);
    const header = request.kind === "handoff"
      ? "【申し送り下書き（AI生成・未確認）】"
      : request.kind === "case_summary"
        ? "【Caseサマリー下書き（AI生成・未確認）】"
        : "【重要事実の抽出（AI生成・未確認）】";

    const statusLine = `現在の状況: ステータス ${aggregate.status} / 優先度 ${aggregate.priority}` +
      (aggregate.assigneeId ? ` / 担当 ${aggregate.assigneeId}` : " / 担当未割当") +
      (aggregate.category ? ` / 区分 ${aggregate.category}` : "");

    const body = [
      header,
      statusLine,
      factLines.length ? "原文から抽出した事項:" : "原文から抽出できた事項はありません。",
      ...factLines,
      ...(request.kind === "handoff" && missing.length
        ? ["次勤務者への確認事項:", ...missing.map((item) => `・${item}`)]
        : []),
      ...(uncertain.length ? ["不確実な情報（要確認）:", ...uncertain.slice(0, 5).map((item) => `・${item}`)] : []),
      "※この下書きは原文の抜粋整理です。診断・治療・緊急搬送の判断は含みません。",
    ];

    return { text: body.join("\n"), facts, missing, uncertain };
  }
}

/** Bounds provider latency; a slow provider fails the draft, not the Case. */
export async function generateWithTimeout(
  provider: AiDraftProvider,
  request: AiDraftRequest,
  timeoutMs: number,
): Promise<AiProviderOutput> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("AI provider timed out"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([provider.generate(request, controller.signal), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
