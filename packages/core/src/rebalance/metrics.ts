/**
 * Concentration metrics + cap-violation detector.
 *
 * Pure functions. Given Positions + latest prices + UserSettings, compute:
 *   - totalValue         (sum of shares × price, falling back to avgCost)
 *   - positionPcts       (per-ticker percent weight)
 *   - sectorPcts         (per-sector percent weight)
 *   - topHoldings        (largest N positions by value)
 *
 * `checkCaps` identifies violations against the user's singlePositionCapPct
 * and sectorCapPct. Returns a typed list — zero entries means the portfolio is
 * inside caps.
 *
 * "Latest prices" is modeled as `Record<ticker, number>`; the rebalance engine
 * fills it from the priceOracle. If a ticker has no price in the map, we fall
 * back to avgCost (stale but better than zero). A separate `pricesResolved`
 * flag in the return value tells the caller how many positions actually used
 * a live price vs. cost-basis fallback.
 *
 * Prices are native to the listing. Concentration math is always computed in
 * USD through the shared portfolio valuation helper.
 */

import type { Position, UserSettings } from '@vantage/db';
import { auditPortfolio, type PortfolioCurrency } from '../portfolio/valuation.js';

export type MoneyCurrency = PortfolioCurrency;

export interface ConcentrationInput {
  positions: ReadonlyArray<Position>;
  /** Ticker → latest price per share. Missing tickers fall back to avgCost. */
  prices: Record<string, number>;
  /**
   * Ticker → currency of that ticker's listing. Every caller must provide the
   * position-derived map so CAD cannot silently fall through as USD.
   */
  currencies: Record<string, MoneyCurrency>;
  /**
   * CAD-per-USD rate. Callers pull this from `getUsdCadRate()` (cached).
   */
  usdCadRate: number;
}

export interface PositionPct {
  ticker: string;
  sector: string | null;
  shares: number;
  pricePerShare: number;
  /** Value in the position's native currency. */
  nativeValue: number;
  /** Value in USD (post-FX conversion if needed). */
  value: number;
  currency: MoneyCurrency;
  pct: number;
  /** true if the price was sourced from the prices map (vs. avgCost fallback). */
  pricedFromMarket: boolean;
}

export interface SectorPct {
  sector: string;
  value: number;
  pct: number;
}

export interface ConcentrationResult {
  /** Portfolio value in USD. */
  totalValue: number;
  /** The same portfolio value converted to CAD. */
  totalValueCad: number;
  /** CAD per USD rate used for every conversion in this snapshot. */
  usdCadRate: number;
  positionPcts: PositionPct[];
  /** Sorted descending by pct. */
  sectorPcts: SectorPct[];
  /** Top N holdings, sorted descending by value. Defaults to 5. */
  topHoldings: PositionPct[];
  /** Number of positions that used a live price (vs avgCost fallback). */
  pricesResolved: number;
}

export interface ComputeConcentrationOptions {
  /** Number of top holdings to return. Defaults to 5. */
  topN?: number;
}

/**
 * Compute portfolio concentration from open positions + latest prices.
 * Zero-valued portfolios return zero percentages (no division-by-zero).
 *
 * Mixed-currency math is strict. An invalid rate or unsupported position
 * currency throws instead of silently corrupting cap weights.
 */
export function computeConcentration(
  input: ConcentrationInput,
  opts: ComputeConcentrationOptions = {},
): ConcentrationResult {
  const topN = opts.topN ?? 5;
  const audit = auditPortfolio({
    positions: input.positions,
    prices: input.prices,
    currencies: input.currencies,
    usdCadRate: input.usdCadRate,
  });
  const positionPcts: PositionPct[] = audit.positions.map((position) => ({
    ticker: position.ticker,
    sector: position.sector,
    shares: position.shares,
    pricePerShare: position.pricePerShare,
    nativeValue: position.nativeValue,
    value: position.valueUsd,
    currency: position.currency,
    pct: position.pct,
    pricedFromMarket: position.pricedFromMarket,
  }));
  const sectorPcts: SectorPct[] = [...audit.bySector].map(([sector, value]) => ({
    sector,
    value: value.valueUsd,
    pct: value.pct,
  }));
  sectorPcts.sort((a, b) => b.pct - a.pct);

  const topHoldings = [...positionPcts].sort((a, b) => b.value - a.value).slice(0, topN);

  return {
    totalValue: audit.totalValueUsd,
    totalValueCad: audit.totalValueCad,
    usdCadRate: audit.usdCadRate,
    positionPcts,
    sectorPcts,
    topHoldings,
    pricesResolved: audit.pricesResolved,
  };
}

// ---------------------------------------------------------------------------
// Cap violations
// ---------------------------------------------------------------------------

export type CapViolationKind = 'single' | 'sector';

export interface ConcentrationViolation {
  kind: CapViolationKind;
  ticker?: string;
  sector?: string;
  /** Current percentage — either position pct or sector pct. */
  pct: number;
  /** The configured cap that was breached. */
  cap: number;
  /** How far over (pct - cap). Always positive. */
  overBy: number;
}

export interface CheckCapsResult {
  violations: ConcentrationViolation[];
}

/**
 * Compare the concentration numbers against the user's caps. Returns one
 * entry per ticker/sector that exceeds its respective cap. A 1e-6 epsilon
 * tolerance avoids flagging values that are exactly at the cap due to
 * floating-point noise.
 */
export function checkCaps(
  concentration: ConcentrationResult,
  settings: Pick<UserSettings, 'singlePositionCapPct' | 'sectorCapPct'>,
): CheckCapsResult {
  const violations: ConcentrationViolation[] = [];
  const single = settings.singlePositionCapPct;
  const sectorCap = settings.sectorCapPct;

  for (const pp of concentration.positionPcts) {
    if (pp.pct > single + 1e-6) {
      violations.push({
        kind: 'single',
        ticker: pp.ticker,
        pct: pp.pct,
        cap: single,
        overBy: pp.pct - single,
      });
    }
  }

  for (const sp of concentration.sectorPcts) {
    if (sp.pct > sectorCap + 1e-6) {
      violations.push({
        kind: 'sector',
        sector: sp.sector,
        pct: sp.pct,
        cap: sectorCap,
        overBy: sp.pct - sectorCap,
      });
    }
  }

  // Sort by severity (largest overBy first) so callers can prioritize.
  violations.sort((a, b) => b.overBy - a.overBy);
  return { violations };
}
