/**
 * Keyword pre-filter — the cheapest and single biggest cost lever in the
 * ingestion pipeline.
 *
 * Runs on every candidate Article BEFORE any LLM call. If the article body /
 * headline doesn't mention a symbol we hold or watch (or a known alias), we
 * discard without touching the Haiku relevance filter.
 *
 * Matching rules:
 * - Case-insensitive.
 * - Symbol match is word-boundary-anchored (\bAAPL\b) to avoid matching inside
 *   unrelated words (e.g. "AI" inside "waifu", "MU" inside "mutual").
 * - Alias match is word-boundary-anchored around the whole alias phrase, and
 *   internal whitespace in aliases is normalized to \s+ so "New  York Times"
 *   and "New York Times" both match "New York Times".
 * - Returns the matched symbols (deduped, original-case symbol preserved).
 */

export interface TickerSpec {
  symbol: string;
  /** Optional company-name aliases: "Apple", "Apple Inc", "Apple Inc." */
  aliases?: string[];
}

/**
 * Escape a string for use in a RegExp literal. Standard escape set.
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a word-boundary regex that matches the alias (whitespace-tolerant)
 * case-insensitively.
 *
 * \b only matches between a word character and a non-word character. If the
 * alias starts/ends with punctuation (e.g. "Apple Inc.", ".NET"), the raw \b
 * would fail to anchor correctly. We switch to lookarounds that require a
 * non-word character (or string boundary) on the appropriate side, which
 * handles both alphanumeric-edged and punctuation-edged aliases.
 */
function buildAliasRegex(alias: string): RegExp {
  const parts = alias
    .trim()
    .split(/\s+/)
    .map((p) => escapeRegExp(p));
  const body = parts.join('\\s+');

  const firstChar = alias.trim().charAt(0);
  const lastChar = alias.trim().charAt(alias.trim().length - 1);
  // `\w` for ASCII-word-char check (company names are almost always ASCII).
  const alphaBoundary = /[A-Za-z0-9_]/;
  const leftAnchor = alphaBoundary.test(firstChar)
    ? '(?:^|\\W)'
    : '(?:^|(?<=\\w))';
  const rightAnchor = alphaBoundary.test(lastChar)
    ? '(?:$|\\W)'
    : '(?:$|(?=\\w)|(?=\\s))';

  return new RegExp(`${leftAnchor}(?:${body})${rightAnchor}`, 'i');
}

/**
 * Return the list of ticker symbols mentioned in `text`. Symbols are returned
 * in the original casing as provided in the input spec list. De-duplicated.
 *
 * Designed to be hot-loop cheap — no allocations per character.
 */
export function hasTickerMention(
  text: string,
  tickers: ReadonlyArray<TickerSpec>,
): string[] {
  if (!text || tickers.length === 0) return [];
  const matched = new Set<string>();

  for (const t of tickers) {
    const symbol = t.symbol;
    if (!symbol) continue;

    // Match the symbol itself — case-insensitive, word-boundary anchored.
    const symbolRe = new RegExp(`\\b${escapeRegExp(symbol)}\\b`, 'i');
    if (symbolRe.test(text)) {
      matched.add(symbol);
      continue; // no need to check aliases if the symbol matched
    }

    // Alias fallback.
    if (t.aliases && t.aliases.length > 0) {
      for (const alias of t.aliases) {
        if (!alias) continue;
        if (buildAliasRegex(alias).test(text)) {
          matched.add(symbol);
          break;
        }
      }
    }
  }

  return [...matched];
}
