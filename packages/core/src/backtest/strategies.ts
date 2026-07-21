/**
 * Backtest strategy utilities — pure, testable.
 *
 * These are deterministic replay helpers. They do NOT call the LLM — the
 * production monthly-allocation digest uses Sonnet, but a backtest needs
 * reproducibility, so we stand in with rule-based logic. See the docstring in
 * `backtest/engine.ts` for the full rationale.
 *
 * Functions:
 *   - `equalWeightAllocate`  : distribute available cash across eligible
 *                              candidates, one equal slice per ticker, while
 *                              respecting single-position + sector caps.
 *   - `trimToCapOnly`        : for each position over the single-position cap,
 *                              emit a trim trade that brings it back to cap.
 */

import type { BacktestTrade, BacktestPosition, BacktestCaps } from './types.js';

export interface EqualWeightAllocateInput {
  date: Date;
  cashUsd: number;
  candidates: ReadonlyArray<string>;
  /** ticker → price on `date` (must be present for a ticker to be considered). */
  prices: Record<string, number>;
  caps: BacktestCaps;
  currentPositions: ReadonlyArray<BacktestPosition>;
  /** sector map (optional) — if provided, sector caps are enforced. */
  sectors?: Record<string, string | null>;
}

/**
 * Equal-weight candidate allocator.
 *
 * Algorithm:
 *   1. Filter candidates to those that (a) have a price on `date` and
 *      (b) are not already at or above the single-position cap.
 *   2. Portfolio "total value" = cash + sum(position.shares * current price).
 *      If a candidate has no price, it's skipped (not included in the slate).
 *   3. Split available cash equally across eligible candidates.
 *   4. For each slice:
 *        - clamp by single-position cap (new_ticker_value ≤ cap% of total)
 *        - clamp by sector cap when sector is known
 *        - compute fractional shares (2-decimal rounding, minimum 0.01)
 *   5. Emit one `buy` trade per candidate with a non-zero share count.
 *
 * Returns the list of trades + the final cash after all buys.
 */
export function equalWeightAllocate(input: EqualWeightAllocateInput): {
  trades: BacktestTrade[];
  remainingCash: number;
} {
  const { date, candidates, prices, caps, currentPositions, sectors } = input;
  let cashRemaining = input.cashUsd;
  const trades: BacktestTrade[] = [];

  // Build a live map of ticker → value at current prices.
  const positionsByTicker = new Map<string, BacktestPosition>();
  for (const p of currentPositions) {
    positionsByTicker.set(p.ticker.toUpperCase(), { ...p });
  }

  const valueOf = (ticker: string): number => {
    const pos = positionsByTicker.get(ticker.toUpperCase());
    if (!pos) return 0;
    const price = priceOrNull(prices, ticker);
    if (price === null) return pos.shares * pos.avgCost;
    return pos.shares * price;
  };

  const sectorValueAgg = (): Map<string, number> => {
    const out = new Map<string, number>();
    if (!sectors) return out;
    for (const ticker of positionsByTicker.keys()) {
      const sector = sectors[ticker] ?? null;
      if (!sector) continue;
      const v = valueOf(ticker);
      out.set(sector, (out.get(sector) ?? 0) + v);
    }
    return out;
  };

  // Eligibility: has price + not already at cap.
  const portfolioValueSnapshot = (): number => {
    let total = cashRemaining;
    for (const ticker of positionsByTicker.keys()) total += valueOf(ticker);
    return total;
  };

  const eligible: string[] = [];
  const totalNow = portfolioValueSnapshot();
  for (const rawTicker of candidates) {
    const ticker = rawTicker.toUpperCase();
    const price = priceOrNull(prices, ticker);
    if (price === null) continue;
    const currentValue = valueOf(ticker);
    const pctNow = totalNow > 0 ? (currentValue / totalNow) * 100 : 0;
    if (pctNow >= caps.singlePositionCapPct) continue;
    eligible.push(ticker);
  }

  if (eligible.length === 0 || cashRemaining <= 0) {
    return { trades, remainingCash: cashRemaining };
  }

  // Equal slice. We don't reserve for caps up front — we clamp each slice
  // independently. After a couple of fully-funded buys the slate shrinks
  // organically.
  const perSliceCash = cashRemaining / eligible.length;

  for (const ticker of eligible) {
    if (cashRemaining < 0.01) break;
    const price = priceOrNull(prices, ticker);
    if (price === null) continue;

    const projectedTotal = portfolioValueSnapshot();
    const tickerCurrentValue = valueOf(ticker);
    const singleCapValue = (caps.singlePositionCapPct / 100) * projectedTotal;
    const sectorCapValue = (caps.sectorCapPct / 100) * projectedTotal;

    const sector = sectors?.[ticker] ?? null;
    const sectorCurrent = sector ? (sectorValueAgg().get(sector) ?? 0) : 0;

    const roomSingle = Math.max(0, singleCapValue - tickerCurrentValue);
    const roomSector = sector ? Math.max(0, sectorCapValue - sectorCurrent) : Infinity;
    const roomCash = Math.max(0, Math.min(cashRemaining, perSliceCash));

    const dollars = Math.min(roomCash, roomSingle, roomSector);
    if (dollars < price * 0.01) continue; // can't buy ≥ 0.01 sh

    // Fractional shares to 2 decimals.
    const shares = Math.floor((dollars / price) * 100) / 100;
    if (shares < 0.01) continue;
    const actualDollars = shares * price;

    trades.push({
      date: new Date(date.getTime()),
      ticker,
      kind: 'buy',
      shares,
      price,
      dollars: round2(actualDollars),
      rationale: `equal-weight deterministic allocation (slice ${fmt(perSliceCash)}, clamped by caps to ${fmt(dollars)})`,
    });
    cashRemaining -= actualDollars;

    // Update positions map so later candidates see the new exposure.
    const existing = positionsByTicker.get(ticker);
    if (existing) {
      const totalShares = existing.shares + shares;
      const totalCost = existing.shares * existing.avgCost + actualDollars;
      existing.shares = totalShares;
      existing.avgCost = totalCost / totalShares;
    } else {
      positionsByTicker.set(ticker, {
        ticker,
        shares,
        avgCost: price,
      });
    }
  }

  return { trades, remainingCash: cashRemaining };
}

export interface TrimToCapOnlyInput {
  date: Date;
  positions: ReadonlyArray<BacktestPosition>;
  prices: Record<string, number>;
  caps: BacktestCaps;
  sectors?: Record<string, string | null>;
  cashUsd: number;
}

/**
 * Trim-only strategy.
 *
 * For each position over the `singlePositionCapPct`, emit a trim trade that
 * sells just enough shares to bring the position back to the cap. Sector
 * overages aren't acted on here — only single-position breaches — because a
 * sector breach without a single-position breach implies rotation (out of
 * scope for this deterministic helper).
 */
export function trimToCapOnly(input: TrimToCapOnlyInput): {
  trades: BacktestTrade[];
} {
  const { date, positions, prices, caps } = input;
  const trades: BacktestTrade[] = [];

  // Total value using market prices where available, avgCost as fallback.
  let total = input.cashUsd;
  const valMap = new Map<string, number>();
  for (const p of positions) {
    const t = p.ticker.toUpperCase();
    const price = priceOrNull(prices, t);
    const per = price ?? p.avgCost;
    const value = p.shares * per;
    valMap.set(t, value);
    total += value;
  }

  if (total <= 0) return { trades };

  const singleCapValue = (caps.singlePositionCapPct / 100) * total;
  for (const p of positions) {
    const t = p.ticker.toUpperCase();
    const value = valMap.get(t) ?? 0;
    if (value <= singleCapValue + 1e-6) continue;
    const excessValue = value - singleCapValue;
    const price = priceOrNull(prices, t);
    const per = price ?? p.avgCost;
    if (per <= 0) continue;
    const sharesRaw = excessValue / per;
    const shares = Math.floor(sharesRaw * 100) / 100;
    if (shares < 0.01) continue;
    const dollars = round2(shares * per);
    const clamped = Math.min(shares, p.shares);
    if (clamped < 0.01) continue;
    trades.push({
      date: new Date(date.getTime()),
      ticker: t,
      kind: clamped >= p.shares ? 'exit' : 'trim',
      shares: clamped,
      price: per,
      dollars,
      rationale: `deterministic trim-to-cap: position at ${((value / total) * 100).toFixed(2)}% > cap ${caps.singlePositionCapPct}%`,
    });
  }
  return { trades };
}

// -- helpers -----------------------------------------------------------------

function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '$0.00';
  return `$${n.toFixed(2)}`;
}

/**
 * Safe `Record<string, number>` access under `noUncheckedIndexedAccess`.
 * Returns null when the ticker is missing, non-finite, or non-positive.
 */
function priceOrNull(prices: Record<string, number>, ticker: string): number | null {
  const v = prices[ticker.toUpperCase()];
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  return v;
}
