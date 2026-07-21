/**
 * Analyst-upgrade detector — Phase 17.
 *
 * Compares the most recent two `AnalystRecommendation` rows for a ticker
 * and emits an `UpgradeEvent` when:
 *   - `strongBuy + buy` has increased by ≥ 2 between periods, OR
 *   - the consensus tier has shifted (Hold → Buy, Buy → Strong Buy, etc.)
 *
 * The Finnhub free tier returns aggregate counts only — no firm names — so
 * the spec's "tier-1 firm shift" criterion is approximated via the
 * aggregate-shift signal. A single tier-1 firm upgrading typically moves
 * the strongBuy + buy total by 1-2; a chain of upgrades within a month
 * compounds clearly.
 *
 * Pure function: takes the two-row pair, returns either an UpgradeEvent or
 * null. Caller (pollAnalysts) is responsible for persisting + deduping.
 */

import type { AnalystRecommendation } from '@vantage/db';

export type Consensus = 'StrongBuy' | 'Buy' | 'Hold' | 'Sell' | 'StrongSell';

export interface UpgradeEvent {
  ticker: string;
  /** Δ(strongBuy_current − strongBuy_prior). */
  deltaStrongBuy: number;
  /** Δ(buy_current − buy_prior). */
  deltaBuy: number;
  fromConsensus: Consensus;
  toConsensus: Consensus;
  /** First-of-month timestamp the current-period row covers. */
  period: Date;
}

interface RecRow {
  ticker: string;
  period: Date;
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
}

const TIER_ORDER: Record<Consensus, number> = {
  StrongBuy: 5,
  Buy: 4,
  Hold: 3,
  Sell: 2,
  StrongSell: 1,
};

/**
 * Determine the modal consensus for a recommendation row. Highest count
 * wins; ties break toward the more bullish tier (so a 3-Buy / 3-Hold split
 * is "Buy", not "Hold"). Empty rows return "Hold" — neutral default.
 */
export function consensusFromRow(
  row: Pick<
    RecRow,
    'strongBuy' | 'buy' | 'hold' | 'sell' | 'strongSell'
  >,
): Consensus {
  const counts: Array<[Consensus, number]> = [
    ['StrongBuy', row.strongBuy],
    ['Buy', row.buy],
    ['Hold', row.hold],
    ['Sell', row.sell],
    ['StrongSell', row.strongSell],
  ];
  let best: Consensus = 'Hold';
  let bestCount = -1;
  for (const [tier, count] of counts) {
    if (count <= 0) continue;
    if (
      count > bestCount ||
      (count === bestCount && TIER_ORDER[tier] > TIER_ORDER[best])
    ) {
      best = tier;
      bestCount = count;
    }
  }
  return best;
}

export interface DetectUpgradeOptions {
  /** Minimum (Δstrong + Δbuy) summed delta to fire on raw shift. Default 2. */
  minBullishDelta?: number;
}

/**
 * Compare current period vs prior period; return an UpgradeEvent when the
 * shift meets the threshold. `rows` is expected sorted descending by period
 * (newest first); rows.length < 2 is a no-op.
 */
export function detectUpgrade(
  rows: readonly AnalystRecommendation[],
  opts: DetectUpgradeOptions = {},
): UpgradeEvent | null {
  if (rows.length < 2) return null;
  const minDelta = opts.minBullishDelta ?? 2;
  const current = rows[0];
  const prior = rows[1];
  if (!current || !prior) return null;

  const deltaStrongBuy = current.strongBuy - prior.strongBuy;
  const deltaBuy = current.buy - prior.buy;
  const summedBullish = deltaStrongBuy + deltaBuy;

  const fromConsensus = consensusFromRow(prior);
  const toConsensus = consensusFromRow(current);
  const tierShifted =
    TIER_ORDER[toConsensus] > TIER_ORDER[fromConsensus];

  if (summedBullish < minDelta && !tierShifted) {
    return null;
  }

  return {
    ticker: current.ticker.toUpperCase(),
    deltaStrongBuy,
    deltaBuy,
    fromConsensus,
    toConsensus,
    period: current.period,
  };
}

/**
 * Convenience overload — many callers have only the two rows handy. This
 * is a thin wrapper around `detectUpgrade` to keep call sites readable.
 */
export function detectUpgrades(
  pairs: ReadonlyArray<readonly AnalystRecommendation[]>,
  opts?: DetectUpgradeOptions,
): UpgradeEvent[] {
  const events: UpgradeEvent[] = [];
  for (const rows of pairs) {
    const ev = detectUpgrade(rows, opts);
    if (ev) events.push(ev);
  }
  return events;
}
