/**
 * Aggregate multiple Position rows that share a ticker (one row per account)
 * into a single portfolio-wide view. Used by digests, the catalyst engine,
 * and discovery scorers that previously assumed `Position.ticker` was unique.
 *
 * Pure data — no DB calls. Callers must pre-load positions with the
 * account relation included.
 */

export interface RawPositionRow {
  ticker: string;
  /** Pass `Number(prisma.Decimal)` at the boundary. */
  shares: number;
  avgCost: number;
  account: { id: number; type: string };
}

export interface AggregatedPosition {
  ticker: string;
  totalShares: number;
  weightedAvgCost: number;
  accountBreakdown: ReadonlyArray<{
    accountId: number;
    accountType: string;
    shares: number;
    avgCost: number;
  }>;
}

/**
 * Group rows by ticker. Within each ticker, totalShares sums shares across
 * lots and weightedAvgCost is the share-weighted mean of avgCost (i.e. the
 * blended cost basis). Zero-share groups (defensive) produce weightedAvgCost=0.
 * Output is sorted by ticker ascending so digest emission is deterministic.
 */
export function aggregatePositionsByTicker(
  positions: readonly RawPositionRow[],
): AggregatedPosition[] {
  const byTicker = new Map<string, {
    totalShares: number;
    costNotional: number;
    breakdown: AggregatedPosition['accountBreakdown'][number][];
  }>();

  for (const p of positions) {
    const key = p.ticker;
    const entry = byTicker.get(key) ?? {
      totalShares: 0,
      costNotional: 0,
      breakdown: [],
    };
    entry.totalShares += p.shares;
    entry.costNotional += p.shares * p.avgCost;
    entry.breakdown.push({
      accountId: p.account.id,
      accountType: p.account.type,
      shares: p.shares,
      avgCost: p.avgCost,
    });
    byTicker.set(key, entry);
  }

  const out: AggregatedPosition[] = [];
  for (const [ticker, agg] of byTicker) {
    const weightedAvgCost =
      agg.totalShares > 0 ? agg.costNotional / agg.totalShares : 0;
    out.push({
      ticker,
      totalShares: agg.totalShares,
      weightedAvgCost,
      accountBreakdown: agg.breakdown,
    });
  }
  out.sort((a, b) => a.ticker.localeCompare(b.ticker));
  return out;
}
