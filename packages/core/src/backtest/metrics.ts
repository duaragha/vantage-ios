/**
 * Backtest metrics — pure helpers.
 *
 *  - `computeDrawdown`  : max peak-to-trough percentage drop across a value
 *                         series. Returned as a positive percentage (12.34 means
 *                         a 12.34% drawdown). Returns 0 when the series is
 *                         empty or monotonically non-decreasing.
 *  - `computeCAGR`      : compound annual growth rate given start + end value
 *                         and an elapsed-years figure. Years <= 0 or invalid
 *                         inputs return 0.
 *  - `computeSharpeApprox`: naive annualized Sharpe from a daily-returns
 *                           series. Uses sample std-dev and √252 annualization.
 *                           `riskFreeRate` defaults to 0 (research-grade, not
 *                           risk-adjusted against T-bills).
 *
 * All three are pure — no DB, no I/O, no side-effects.
 */

/**
 * Max peak-to-trough drawdown across a value series, as a positive percent.
 *
 * Algorithm:
 *   track running max so far; for each point compute
 *     drawdown = (max - current) / max
 *   track the largest drawdown seen. Result is returned × 100.
 */
export function computeDrawdown(valueSeries: ReadonlyArray<number>): number {
  if (!valueSeries || valueSeries.length === 0) return 0;
  let peak = -Infinity;
  let maxDd = 0;
  for (const v of valueSeries) {
    if (!Number.isFinite(v)) continue;
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = (peak - v) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return maxDd * 100;
}

/**
 * Compound annual growth rate (CAGR), returned as a decimal percent.
 * Example: a 10% annualized return returns 10, not 0.10.
 */
export function computeCAGR(
  startValue: number,
  endValue: number,
  years: number,
): number {
  if (
    !Number.isFinite(startValue) ||
    !Number.isFinite(endValue) ||
    !Number.isFinite(years)
  ) {
    return 0;
  }
  if (startValue <= 0 || years <= 0) return 0;
  const ratio = endValue / startValue;
  if (ratio <= 0) return -100; // total loss floor
  const cagr = Math.pow(ratio, 1 / years) - 1;
  return cagr * 100;
}

/**
 * Naive annualized Sharpe-like ratio from a daily-returns series.
 *
 * `returns` is a list of period-over-period *decimal* returns (0.01 for +1%).
 * `riskFreeRate` is the annual risk-free rate as a decimal (0.04 = 4%). We
 * convert it to a per-day figure by dividing by 252.
 *
 * Returns 0 when stddev is zero, the series is too short (<2 points), or any
 * input is non-finite.
 */
export function computeSharpeApprox(
  returns: ReadonlyArray<number>,
  riskFreeRate = 0,
): number {
  if (!returns || returns.length < 2) return 0;
  const rfPerDay = Number.isFinite(riskFreeRate) ? riskFreeRate / 252 : 0;
  const excess: number[] = [];
  for (const r of returns) {
    if (!Number.isFinite(r)) continue;
    excess.push(r - rfPerDay);
  }
  if (excess.length < 2) return 0;

  const mean = excess.reduce((s, v) => s + v, 0) / excess.length;
  let sqSum = 0;
  for (const v of excess) {
    const d = v - mean;
    sqSum += d * d;
  }
  // sample std-dev (n-1)
  const variance = sqSum / (excess.length - 1);
  const stddev = Math.sqrt(variance);
  if (!Number.isFinite(stddev) || stddev === 0) return 0;
  return (mean / stddev) * Math.sqrt(252);
}

/**
 * Convert a running value series into period-over-period decimal returns.
 * Utility for `computeSharpeApprox` callers that have values, not returns.
 */
export function seriesToReturns(values: ReadonlyArray<number>): number[] {
  if (!values || values.length < 2) return [];
  const out: number[] = [];
  for (let i = 1; i < values.length; i += 1) {
    const prev = values[i - 1];
    const cur = values[i];
    if (prev === undefined || cur === undefined) continue;
    if (!Number.isFinite(prev) || !Number.isFinite(cur) || prev <= 0) continue;
    out.push(cur / prev - 1);
  }
  return out;
}
