/**
 * FX conversion helpers — Phase 16 multi-currency support.
 *
 * One pair matters to this project: USD ↔ CAD. Raghav is a Canadian retail
 * investor; US listings report in USD and his TSX/NEO/TSX-V listings report
 * in CAD. Portfolio totals + concentration caps are computed in USD, so we
 * need a reliable rate.
 *
 * Source: FRED series `DEXCAUS` (Canadian dollars per US dollar, business-day
 * daily). FRED updates Fri PM for Thursday close; weekends & holidays return
 * the prior business day's rate, so caching stale values is safe.
 *
 * Caching: 1h in-process, single shared value. Process restart re-fetches on
 * demand. If FRED is down or the key is missing, we fall back to the
 * configurable `FX_USD_CAD_FALLBACK` env var (defaults to 1.36, the long-term
 * ~average as of 2026) and log a warn once per hour.
 */

import { FredAdapter } from '@vantage/sources';

/** Fallback rate used when FRED is unreachable. */
const DEFAULT_FALLBACK_RATE = 1.36;

/** Cache TTL — 1h. FRED daily series update well inside this window. */
const CACHE_TTL_MS = 60 * 60 * 1000;

interface CachedRate {
  value: number;
  fetchedAt: number;
  source: 'fred' | 'fallback';
}

let _cache: CachedRate | null = null;
let _fred: FredAdapter | null = null;

/** Test hook — clears the cache so the next call refetches. */
export function __resetFxCache(): void {
  _cache = null;
}

/** Test hook — inject a FredAdapter (e.g. mock). Pass `null` to reset. */
export function __setFredAdapter(adapter: FredAdapter | null): void {
  _fred = adapter;
}

function getFred(): FredAdapter | null {
  if (_fred) return _fred;
  try {
    _fred = new FredAdapter();
    return _fred;
  } catch {
    // FRED_API_KEY not set — callers will fall back to the constant.
    return null;
  }
}

function fallbackRate(): number {
  const env = process.env['FX_USD_CAD_FALLBACK'];
  if (env) {
    const v = Number.parseFloat(env);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return DEFAULT_FALLBACK_RATE;
}

/**
 * USD → CAD rate. I.e. how many CAD one USD buys.
 *
 * `asOf` is accepted for API symmetry with future historical conversions but
 * currently ignored — the in-process cache always returns the most recent
 * business-day value. For historical backtests we'd swap this for a point-in-
 * time FRED call, but the current rebalance + discovery flows only care about
 * current rates.
 */
export async function getUsdCadRate(asOf?: Date): Promise<number> {
  void asOf;
  const now = Date.now();
  if (_cache && now - _cache.fetchedAt < CACHE_TTL_MS) {
    return _cache.value;
  }

  const fred = getFred();
  if (fred) {
    try {
      const points = await fred.getUsdCadRate(5);
      // FRED returns desc-sorted in the shared adapter helper. Take the
      // first non-null observation.
      const latest = points.find(
        (p) => p.value !== null && Number.isFinite(p.value) && (p.value as number) > 0,
      );
      if (latest && typeof latest.value === 'number') {
        _cache = { value: latest.value, fetchedAt: now, source: 'fred' };
        return latest.value;
      }
    } catch (err) {
      console.warn(
        '[fx] FRED DEXCAUS fetch failed, using fallback:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  const fb = fallbackRate();
  _cache = { value: fb, fetchedAt: now, source: 'fallback' };
  console.warn(`[fx] using fallback USD/CAD rate ${fb}`);
  return fb;
}

/**
 * Convert `amount` in `currency` to USD. USD inputs pass through unchanged.
 * Any unknown currency is treated as USD (defensive — we only currently write
 * USD/CAD into the DB).
 */
export async function convertToUsd(
  amount: number,
  currency: 'USD' | 'CAD' | string,
  asOf?: Date,
): Promise<number> {
  if (!Number.isFinite(amount)) return amount;
  const c = currency.toUpperCase();
  if (c === 'USD' || !c) return amount;
  if (c === 'CAD') {
    const rate = await getUsdCadRate(asOf);
    if (!Number.isFinite(rate) || rate <= 0) return amount;
    return amount / rate;
  }
  return amount;
}

/**
 * Synchronous USD conversion using a rate the caller has already fetched.
 * Useful inside tight loops (metrics.ts computeConcentration) so we don't
 * await on every position.
 */
export function convertToUsdWithRate(
  amount: number,
  currency: 'USD' | 'CAD' | string,
  usdCadRate: number,
): number {
  if (!Number.isFinite(amount)) return amount;
  const c = currency.toUpperCase();
  if (c === 'USD' || !c) return amount;
  if (c === 'CAD') {
    if (!Number.isFinite(usdCadRate) || usdCadRate <= 0) return amount;
    return amount / usdCadRate;
  }
  return amount;
}

/**
 * Inspect the cache. Primarily for ops logging — not an API surface.
 */
export function getCachedFxRate(): CachedRate | null {
  return _cache;
}
