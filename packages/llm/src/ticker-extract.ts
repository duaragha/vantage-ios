/**
 * Ticker extraction from general-market articles.
 *
 * Two-pass pipeline:
 *   Pass 1 — regex + alias dictionary over TickerUniverse (cheap, always runs).
 *   Pass 2 — Haiku fallback, ONLY when Pass 1 returns nothing AND the article
 *            is tier-1 AND we haven't exhausted the daily Haiku budget.
 *
 * Why this shape:
 *   - Articles in pollMarketNews arrive with tickers=[]. Extraction fills them
 *     so downstream (discovery, relevance) has something to key on.
 *   - Single-letter plain-caps matches ("A", "I", "K") are false-positive heavy;
 *     only accept them when cashtag-anchored ($A).
 *   - Haiku is budgeted hard (20/day) — market news volume can spike and
 *     Haiku calls are real money. Hit the cap → we skip pass 2 silently.
 *
 * Budget bookkeeping: every Haiku fallback call writes an LlmCall row with
 * purpose='ticker-extract'. The daily cap check counts these since local
 * midnight (America/Toronto). No separate counter table needed.
 */

import { prisma, getAliasMap, startOfZonedDay } from '@vantage/db';
import { componentLogger } from '@vantage/notify';
import { callClaude } from './client.js';
import type { LlmPurpose } from './client.js';
import { HAIKU_MODEL } from './tier.js';
import type Anthropic from '@anthropic-ai/sdk';

const log = componentLogger('llm/ticker-extract');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TickerExtractInput {
  headline: string;
  body?: string | null;
  /** 1 | 2 | 3 — used to gate Haiku fallback (tier-1 only). */
  sourceTier: number;
}

export type TickerExtractMethod = 'regex' | 'haiku' | 'none';

export interface TickerExtractResult {
  tickers: string[];
  method: TickerExtractMethod;
}

export interface ExtractTickersOptions {
  /**
   * If true, skip the Haiku fallback entirely (even when regex finds nothing
   * and the article is tier-1). Used by smoke tests to keep runs deterministic
   * and to mock-out the LLM path when cached universes are not loaded.
   */
  disableHaiku?: boolean;
}

// ---------------------------------------------------------------------------
// Universe cache (singleton, 6h TTL)
// ---------------------------------------------------------------------------

interface UniverseCache {
  loadedAt: number;
  symbols: Set<string>;
  /**
   * Lowercased alias → one-or-more canonical symbols. Phase 16: a single
   * company name can map to both its US and CA listing (e.g. "shopify" →
   * [SHOP, SHOP.TO]). We emit every match so downstream can disambiguate.
   */
  aliasToSymbol: Map<string, string[]>;
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h

let _cache: UniverseCache | null = null;

/** Test hook — clears the cache so the next call repopulates it. */
export function __resetTickerUniverseCache(): void {
  _cache = null;
}

async function loadUniverse(): Promise<UniverseCache> {
  if (_cache && Date.now() - _cache.loadedAt < CACHE_TTL_MS) return _cache;

  const aliasMap = await getAliasMap();
  const symbols = new Set<string>();
  const aliasToSymbol = new Map<string, string[]>();

  const addMapping = (alias: string, symbol: string): void => {
    const key = alias.toLowerCase().trim();
    if (!key) return;
    const existing = aliasToSymbol.get(key);
    if (existing) {
      if (!existing.includes(symbol)) existing.push(symbol);
    } else {
      aliasToSymbol.set(key, [symbol]);
    }
  };

  for (const [symbol, aliases] of aliasMap.entries()) {
    const s = symbol.toUpperCase();
    symbols.add(s);
    addMapping(s, s); // symbol aliases itself
    for (const alias of aliases) {
      if (!alias || alias.length < 2) continue;
      addMapping(alias, s);
    }
  }

  _cache = { loadedAt: Date.now(), symbols, aliasToSymbol };
  return _cache;
}

// ---------------------------------------------------------------------------
// Pass 1 — regex + alias dictionary
// ---------------------------------------------------------------------------

/**
 * English all-caps words that collide with 2-5 letter ticker symbols. Never
 * resolve to a ticker unless cashtag-anchored. Extend as false positives surface.
 */
const ALLCAPS_STOPWORDS = new Set<string>([
  // Titles / acronyms
  'CEO',
  'CFO',
  'CTO',
  'COO',
  'CIO',
  'CMO',
  'CHRO',
  // Countries / regions
  'USA',
  'US',
  'UK',
  'EU',
  'UN',
  'ASIA',
  'EMEA',
  'APAC',
  'LATAM',
  'NATO',
  'OPEC',
  // Tech acronyms
  'AI',
  'IT',
  'IP',
  'IPO',
  'CES',
  'CEX',
  'DEX',
  'NFT',
  'DAO',
  'DEFI',
  'API',
  'SDK',
  'CLI',
  'URL',
  'HTML',
  'CSS',
  'JSON',
  'XML',
  'SQL',
  'LLM',
  'GPU',
  'CPU',
  'RAM',
  'SSD',
  'HDD',
  // Finance / econ
  'GDP',
  'CPI',
  'SEC',
  'FBI',
  'FDA',
  'DOJ',
  'FTC',
  'IRS',
  'OSC',
  'ETF',
  'ESG',
  'ETFS',
  'REIT',
  'REITS',
  'IRA',
  'ROI',
  'ROE',
  'ROA',
  'FY',
  'YOY',
  'QOQ',
  'YTD',
  'MTD',
  'QTR',
  'EPS',
  'EBIT',
  'EBITDA',
  'NYSE',
  'NASDAQ',
  'OTC',
  'LSE',
  'TSX',
  'AMEX',
  'USD',
  'EUR',
  'JPY',
  'CNY',
  'GBP',
  'CAD',
  'AUD',
  'CHF',
  'INR',
  // English words that commonly trip the regex
  'AND',
  'OR',
  'NOT',
  'FOR',
  'ARE',
  'THE',
  'THIS',
  'WITH',
  'FROM',
  'HAS',
  'HAVE',
  'HAD',
  'WAS',
  'WERE',
  'BEEN',
  'BEING',
  'NEW',
  'OLD',
  'BIG',
  'TOP',
  'END',
  'ONE',
  'TWO',
  'ALL',
  'ANY',
  'NOW',
  'HOW',
  'WHO',
  'WHY',
  'OUT',
  'OUR',
  'OWN',
  'OFF',
  'SEE',
  'SET',
  'GET',
  'PUT',
  'YES',
  'NO',
  'MAY',
  'CAN',
  'WILL',
  'JUST',
  'OVER',
  'MORE',
  'LESS',
  'THAN',
  'WHEN',
  'THEN',
  'WERE',
  'BUT',
  'ITS',
  'HIS',
  'HER',
  'HERS',
  'THEIR',
  'WALL',
  'STREET',
  'MAIN',
  'KEY',
  'WAY',
  'DAY',
  'YEAR',
  'WEEK',
  'MONTH',
  'BANK',
  'CASH',
  'LOAN',
  'DEBT',
  'RATE',
  'RATES',
  'DEAL',
  'DEALS',
  'NEWS',
  'HITS',
  'RISE',
  'FALL',
  'GAIN',
  'LOSS',
  'HIGH',
  'LOW',
  'LIVE',
  'BUY',
  'SELL',
  'HOLD',
  'LONG',
  'SHORT',
  'CALL',
  'PUT',
  'BET',
  'BETS',
  'PEAK',
  'DROP',
  'JUMP',
  'SLIP',
  'SURGE',
  'DIVE',
  'SPIKE',
  'DIP',
  'ORAL',
  'ABLE',
  'ISN',
  'DONT',
  'ITS',
  // Times
  'AM',
  'PM',
  'EST',
  'EDT',
  'PST',
  'PDT',
  'CST',
  'CDT',
  'GMT',
  'UTC',
  // Days / months (some valid tickers collide — prefer stopword)
  'MON',
  'TUE',
  'WED',
  'THU',
  'FRI',
  'SAT',
  'SUN',
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
]);

/**
 * Scoring: cashtag ($AAPL) = 3, alias phrase = 2, plain ALL-CAPS = 1. Higher
 * wins; ties resolved alphabetically for determinism.
 */
interface ScoredMatch {
  symbol: string;
  score: number;
}

function regexExtract(text: string, universe: UniverseCache, maxResults = 5): string[] {
  const matches = new Map<string, ScoredMatch>();
  const bump = (symbol: string, score: number): void => {
    const existing = matches.get(symbol);
    if (!existing || existing.score < score) {
      matches.set(symbol, { symbol, score });
    }
  };

  // Cashtags — $AAPL form. Always trusted. Phase 16: also accept a trailing
  // Canadian exchange suffix — $SHOP.TO / $RY.TO / $NEO.NE. When the
  // cashtag is bare ($SHOP) but BOTH the US and CA listings exist in the
  // universe, bump both so the downstream LLM / user resolves which one.
  const cashtagRe = /\$([A-Z]{1,5})(?:\.(TO|NE|V))?\b/g;
  let m: RegExpExecArray | null;
  while ((m = cashtagRe.exec(text)) !== null) {
    const base = m[1]?.toUpperCase();
    const sfx = m[2]?.toUpperCase();
    if (!base) continue;
    if (sfx) {
      const full = `${base}.${sfx}`;
      if (universe.symbols.has(full)) bump(full, 3);
      continue;
    }
    // Bare cashtag — try the base, then CA variants.
    if (universe.symbols.has(base)) bump(base, 3);
    for (const variant of [`${base}.TO`, `${base}.NE`, `${base}.V`]) {
      if (universe.symbols.has(variant)) bump(variant, 3);
    }
  }

  // Alias phrase search — iterate aliases, indexOf the lowercased text.
  const lowerText = text.toLowerCase();
  for (const [alias, syms] of universe.aliasToSymbol.entries()) {
    if (alias.length < 3) continue; // avoid tiny aliases like "io" that plague substring
    const idx = lowerText.indexOf(alias);
    if (idx < 0) continue;
    const before = idx === 0 ? '' : (lowerText[idx - 1] ?? '');
    const after = lowerText[idx + alias.length] ?? '';
    const boundaryOk = !/[a-z0-9]/i.test(before) && !/[a-z0-9]/i.test(after);
    if (!boundaryOk) continue;
    for (const sym of syms) bump(sym, 2);
  }

  // Plain ALL-CAPS 2-5 letter tokens that exist in the universe.
  const allCapsRe = /\b([A-Z]{2,5})\b/g;
  while ((m = allCapsRe.exec(text)) !== null) {
    const sym = m[1];
    if (!sym) continue;
    if (ALLCAPS_STOPWORDS.has(sym)) continue;
    if (universe.symbols.has(sym)) bump(sym, 1);
  }

  const ranked = [...matches.values()].sort(
    (a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol),
  );
  return ranked.slice(0, maxResults).map((r) => r.symbol);
}

// ---------------------------------------------------------------------------
// Pass 2 — Haiku fallback (budgeted)
// ---------------------------------------------------------------------------

export const EXTRACT_TICKERS_TOOL: Anthropic.Tool = {
  name: 'extract_tickers',
  description:
    'Return an array of US publicly-traded stock tickers with strong editorial relevance to the article. Empty array if none meet the bar.',
  input_schema: {
    type: 'object',
    properties: {
      tickers: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Upper-case US ticker symbols. Only include tickers the article is actually about — not every company mentioned in passing.',
      },
    },
    required: ['tickers'],
    additionalProperties: false,
  },
};

const DAILY_HAIKU_BUDGET = 20;

/**
 * Remaining Haiku ticker-extract budget for today. Uses LlmCall rows keyed
 * by purpose='ticker-extract' + model=HAIKU_MODEL. No new table; we
 * reuse the audit log. The union LlmPurpose type doesn't include
 * 'ticker-extract'; we store it as free text in LlmCall.purpose (the column
 * is TEXT) via an explicit cast at the callClaude boundary.
 */
async function haikuBudgetRemaining(): Promise<number> {
  const since = startOfZonedDay();
  const used = await prisma.llmCall.count({
    where: {
      createdAt: { gte: since },
      model: HAIKU_MODEL,
      purpose: TICKER_EXTRACT_PURPOSE,
    },
  });
  return Math.max(0, DAILY_HAIKU_BUDGET - used);
}

/** Magic purpose marker so the audit log is self-describing. */
const TICKER_EXTRACT_PURPOSE = 'ticker-extract';

/**
 * Haiku fallback call. Uses callClaude for all the wrapper plumbing
 * (kill-switch, spend caps, cost log) but our tool isn't in the shared
 * ALL_TOOLS list so parseToolCalls drops it — we parse the raw response
 * block directly here.
 */
async function haikuExtractDirect(
  input: TickerExtractInput,
  universe: UniverseCache,
): Promise<string[]> {
  const system =
    'You extract US publicly-traded stock tickers from news articles. Only list tickers with strong editorial relevance — not passing mentions of parent companies, unrelated comparables, or off-hand name drops. Return an empty array if no ticker meets that bar. Prefer 0-2 tickers for a typical article; never exceed 5.';

  const userText = [
    `Headline: ${input.headline}`,
    input.body ? `Body:\n${input.body.slice(0, 4000)}` : null,
  ]
    .filter((x): x is string => x !== null)
    .join('\n\n');

  const { response } = await callClaude({
    model: HAIKU_MODEL,
    system,
    messages: [{ role: 'user', content: userText }],
    tools: [EXTRACT_TICKERS_TOOL],
    tool_choice: { type: 'tool', name: 'extract_tickers' },
    maxTokens: 256,
    // LlmPurpose is a string union — our free-text marker needs a cast.
    // The column is plain TEXT so the database accepts it.
    purpose: TICKER_EXTRACT_PURPOSE as unknown as LlmPurpose,
  });

  const rawTickers = extractToolTickers(response);
  if (!rawTickers) return [];

  const validated = rawTickers
    .map((t) => String(t).toUpperCase().trim())
    .filter((t) => /^[A-Z]{1,5}(?:\.(?:TO|NE|V))?$/.test(t) && universe.symbols.has(t));

  return Array.from(new Set(validated)).slice(0, 5);
}

function extractToolTickers(response: Anthropic.Message): string[] | null {
  for (const block of response.content) {
    if (block.type !== 'tool_use') continue;
    if (block.name !== 'extract_tickers') continue;
    const input = block.input;
    if (typeof input !== 'object' || input === null) return null;
    const tickers = (input as Record<string, unknown>)['tickers'];
    if (!Array.isArray(tickers)) return null;
    return tickers.filter((t): t is string => typeof t === 'string');
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract tickers from an article.
 *
 * Contract:
 *   - Pass 1 (regex): always runs. If it returns ≥1 match AND matches are not
 *     all single-letter (defensive), we return with method='regex'.
 *   - Pass 2 (haiku): runs only if Pass 1 is empty AND sourceTier===1 AND
 *     disableHaiku is false AND today's Haiku budget has remaining quota.
 *   - Returns method='none' otherwise.
 */
export async function extractTickers(
  article: TickerExtractInput,
  opts: ExtractTickersOptions = {},
): Promise<TickerExtractResult> {
  const universe = await loadUniverse();
  const text = [article.headline, article.body ?? ''].join('\n');

  const regexHits = regexExtract(text, universe, 5);
  const notAllSingleLetter = regexHits.some((t) => t.length > 1);
  if (regexHits.length > 0 && notAllSingleLetter) {
    return { tickers: regexHits, method: 'regex' };
  }

  if (opts.disableHaiku) return { tickers: [], method: 'none' };
  if (article.sourceTier !== 1) return { tickers: [], method: 'none' };

  const remaining = await haikuBudgetRemaining();
  if (remaining <= 0) return { tickers: [], method: 'none' };

  try {
    const tickers = await haikuExtractDirect(article, universe);
    return { tickers, method: tickers.length > 0 ? 'haiku' : 'none' };
  } catch (err) {
    log.warn({ err, headline: article.headline.slice(0, 120) }, 'Haiku ticker extraction failed');
    return { tickers: [], method: 'none' };
  }
}
