/**
 * Symbol normalization for multi-exchange coverage (Phase 16).
 *
 * Canadian listings on Finnhub + Yahoo both follow the `.TO` / `.NE` / `.V`
 * suffix convention. This module centralizes that convention so every caller
 * — pollTickerUniverse, priceOracle, ticker-extract, dashboard — agrees on:
 *
 *   - which currency a symbol reports in (derived from the exchange code)
 *   - how to split a suffixed symbol into (symbol, suffix, raw)
 *   - how to append the correct suffix when writing a row from a raw symbol
 *
 * Exchange codes used throughout the app:
 *
 *   US  — any US exchange (NYSE, NASDAQ, ARCA). No suffix.
 *   TO  — Toronto Stock Exchange (TSX). Suffix `.TO`.
 *   NE  — Cboe Canada / formerly NEO. Suffix `.NE`.
 *   V   — TSX Venture. Suffix `.V`.
 *
 * Anything else (XNAS, XNYS, ARCX, etc) is treated as a US variant for the
 * currency lookup — we don't write MICs today but the shape tolerates them.
 */

/** Exchange codes the app deliberately supports. */
export type ExchangeCode = 'US' | 'TO' | 'NE' | 'V';

/** Canadian exchanges. Handy guard for priceOracle routing. */
export const CA_EXCHANGES: readonly ExchangeCode[] = ['TO', 'NE', 'V'];

/** Yahoo Finance suffix per Canadian exchange. */
const SUFFIX_BY_EXCHANGE: Record<Exclude<ExchangeCode, 'US'>, string> = {
  TO: '.TO',
  NE: '.NE',
  V: '.V',
};

const EXCHANGE_BY_SUFFIX: Record<string, ExchangeCode> = {
  TO: 'TO',
  NE: 'NE',
  V: 'V',
};

function canonicalCaExchange(exchange: string): Exclude<ExchangeCode, 'US'> | null {
  const normalized = exchange.trim().toUpperCase().replace(/[_ ]+/g, ' ');
  if (['TO', 'TSX', 'XTSE', 'TORONTO STOCK EXCHANGE'].includes(normalized)) return 'TO';
  if (['NE', 'NEO', 'CBOE CANADA', 'AEQUITAS NEO EXCHANGE'].includes(normalized)) return 'NE';
  if (['V', 'TSXV', 'TSX-V', 'XTSX', 'TSX VENTURE'].includes(normalized)) return 'V';
  return null;
}

/**
 * Result of splitting a raw symbol string.
 *
 * Example:
 *   normalizeSymbol("SHOP.TO", "TO") → { symbol: "SHOP.TO", suffix: ".TO", raw: "SHOP" }
 *   normalizeSymbol("AAPL",    "US") → { symbol: "AAPL",    suffix: "",    raw: "AAPL" }
 *   normalizeSymbol("SHOP",    "TO") → { symbol: "SHOP.TO", suffix: ".TO", raw: "SHOP" }
 */
export interface NormalizedSymbol {
  symbol: string;
  suffix: string;
  raw: string;
}

/**
 * Split a symbol string into (canonical symbol, suffix, raw).
 *
 * Input is upper-cased first. If the symbol already carries a suffix it's
 * respected regardless of the `exchange` argument (exchange wins only when
 * the input is bare). If neither source carries a suffix, we treat it as a
 * US symbol.
 */
export function normalizeSymbol(rawInput: string, exchange?: string | null): NormalizedSymbol {
  const upper = rawInput.trim().toUpperCase();
  // Match trailing `.XX` suffix that is a known Canadian one.
  const m = upper.match(/^(.+)\.(TO|NE|V)$/);
  if (m) {
    const base = m[1] ?? upper;
    const sfx = m[2] ?? '';
    return { symbol: upper, suffix: `.${sfx}`, raw: base };
  }
  // No suffix on the input — fall back to `exchange` to decide whether to add one.
  const caExchange = exchange ? canonicalCaExchange(exchange) : null;
  if (caExchange) {
    const sfx = SUFFIX_BY_EXCHANGE[caExchange];
    return { symbol: `${upper}${sfx}`, suffix: sfx, raw: upper };
  }
  return { symbol: upper, suffix: '', raw: upper };
}

/**
 * Append the right suffix to a bare symbol for the given exchange. Idempotent
 * — already-suffixed inputs pass through unchanged.
 */
export function appendSuffix(rawSymbol: string, exchange: string): string {
  return normalizeSymbol(rawSymbol, exchange).symbol;
}

/**
 * Currency of a listing given its exchange code. US → USD; TO/NE/V → CAD.
 * Anything else defaults to USD (safest assumption for our free-data stack).
 */
export function deriveCurrency(exchange: string | null | undefined): 'USD' | 'CAD' {
  if (!exchange) return 'USD';
  return isCaExchange(exchange) ? 'CAD' : 'USD';
}

/** True iff the code is one of TO/NE/V (case-insensitive). */
export function isCaExchange(exchange: string): boolean {
  return canonicalCaExchange(exchange) !== null;
}

/**
 * Flag emoji for a listing's exchange. Used by dashboard badges. Kept here
 * rather than in a React helper so both server components and the LLM layer
 * can reach it without importing JSX.
 */
export function exchangeFlag(exchange: string | null | undefined): string {
  if (!exchange) return '🇺🇸';
  return isCaExchange(exchange) ? '🇨🇦' : '🇺🇸';
}

/**
 * Derive the exchange code from an arbitrary symbol string. Lowercase-safe
 * and tolerates symbols without suffixes (assumes US).
 */
export function exchangeFromSymbol(symbol: string): ExchangeCode {
  const m = symbol
    .trim()
    .toUpperCase()
    .match(/\.(TO|NE|V)$/);
  if (!m || !m[1]) return 'US';
  return EXCHANGE_BY_SUFFIX[m[1]] ?? 'US';
}

/**
 * Resolve listing currency with the symbol suffix as the strongest signal.
 * This repairs legacy rows where a Canadian ticker was stored with USD.
 */
export function resolveListingCurrency(
  symbol: string,
  storedCurrency?: string | null,
  exchange?: string | null,
): 'USD' | 'CAD' {
  if (exchangeFromSymbol(symbol) !== 'US') return 'CAD';
  if (storedCurrency === 'CAD' || storedCurrency === 'USD') return storedCurrency;
  return deriveCurrency(exchange);
}
