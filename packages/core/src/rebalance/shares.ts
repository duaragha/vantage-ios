/**
 * Dollar ↔ shares conversion utilities.
 *
 * Both directions round to 2 decimal places — Wealthsimple supports fractional
 * shares to 2 decimals, matching the spec's "≥ 0.01 shares for fractional"
 * sanity check elsewhere in the rebalance engine.
 *
 * Pure functions. Deliberately don't throw on zero price — returning 0 lets
 * callers decide whether to treat that as "skip" or "retry price oracle".
 */

/**
 * Round a number to `decimals` places using banker's-adjacent rounding (we
 * rely on JS `Math.round` which is half-away-from-zero for positive values —
 * good enough for dollar sizing where we never deal in negatives).
 */
function roundTo(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Compute share count from a target dollar amount and a per-share price.
 * Returns 0 when inputs are invalid (non-finite, non-positive price).
 */
export function computeShares(dollars: number, price: number): number {
  if (!Number.isFinite(dollars) || !Number.isFinite(price)) return 0;
  if (dollars <= 0 || price <= 0) return 0;
  return roundTo(dollars / price, 2);
}

/**
 * Reverse of computeShares — given a share count and a price, compute the
 * dollar notional rounded to cents.
 */
export function computeDollarsFromShares(shares: number, price: number): number {
  if (!Number.isFinite(shares) || !Number.isFinite(price)) return 0;
  if (shares <= 0 || price <= 0) return 0;
  return roundTo(shares * price, 2);
}

/** Minimum share count for fractional orders (spec sanity check). */
export const MIN_FRACTIONAL_SHARES = 0.01;
