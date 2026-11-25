/**
 * Locale-independent Japanese-friendly text normalization for manual search.
 *
 * - NFKC: full-width ASCII → ASCII, half-width katakana → full-width, ideographic space → space
 * - lower-case
 * - katakana → hiragana (テントウ / てんとう match)
 * - whitespace collapsed
 *
 * The same function produces the stored `search_*` columns and the query terms,
 * so in-memory and PostgreSQL search share one definition.
 */
export function normalizeSearchText(value: string): string {
  const nfkc = value.normalize("NFKC").toLowerCase();
  let folded = "";
  for (const char of nfkc) {
    const code = char.codePointAt(0)!;
    // ァ (U+30A1) .. ヶ (U+30F6) → ぁ (U+3041) .. ゖ (U+3096)
    folded += code >= 0x30a1 && code <= 0x30f6
      ? String.fromCodePoint(code - 0x60)
      : char;
  }
  return folded.replace(/\s+/gu, " ").trim();
}

export const MAX_SEARCH_TERMS = 8;
export const MAX_SEARCH_TERM_LENGTH = 40;

/** Whitespace-separated terms; every term must match (AND). */
export function searchTerms(query: string): string[] {
  const normalized = normalizeSearchText(query);
  if (!normalized) return [];
  const terms = [...new Set(normalized.split(" ").filter(Boolean))];
  return terms
    .slice(0, MAX_SEARCH_TERMS)
    .map((term) => term.slice(0, MAX_SEARCH_TERM_LENGTH));
}

export interface SearchDocument {
  title: string;
  tags: string;
  summary: string;
  steps: string;
}

export function searchDocument(input: {
  title: string;
  tags: readonly string[];
  categoryLabel?: string;
  summary: string;
  steps: readonly { text: string }[];
}): SearchDocument {
  return {
    title: normalizeSearchText(input.title),
    tags: normalizeSearchText([...input.tags, input.categoryLabel ?? ""].join(" ")),
    summary: normalizeSearchText(input.summary),
    steps: normalizeSearchText(input.steps.map((step) => step.text).join(" ")),
  };
}

const WEIGHTS = { title: 5, tags: 3, summary: 2, steps: 1 } as const;

/**
 * Score one document. Returns null unless every term matches at least one field.
 * Mirrors `public.framework_search_manuals` in db/framework_store.sql.
 */
export function scoreDocument(
  document: SearchDocument,
  terms: readonly string[],
): { score: number; matchedIn: (keyof SearchDocument)[] } | null {
  if (terms.length === 0) return { score: 0, matchedIn: [] };
  let score = 0;
  const matched = new Set<keyof SearchDocument>();
  for (const term of terms) {
    let termMatched = false;
    for (const field of ["title", "tags", "summary", "steps"] as const) {
      if (document[field].includes(term)) {
        score += WEIGHTS[field];
        matched.add(field);
        termMatched = true;
      }
    }
    if (!termMatched) return null;
  }
  return {
    score,
    matchedIn: (["title", "tags", "summary", "steps"] as const).filter((f) => matched.has(f)),
  };
}
