/**
 * Insider cluster detector — Phase 17.
 *
 * Aggregates per-ticker open-market Form-4 purchases and emits a
 * `ClusterEvent` for each ticker that crosses the conviction threshold.
 *
 * Conviction tiering (per spec 17.1 + research backing):
 *   - HIGH:    distinctInsiders ≥ 3 AND totalUsd ≥ $2M
 *   - MEDIUM:  distinctInsiders ≥ 3 OR totalUsd ≥ $1M
 *   - LOW:     single insider with valueUsd ≥ $500k
 *
 * Anything below LOW is dropped. The detector is signal-emitting only — it
 * does NOT itself write to MarketEvent. The caller (a poller or the
 * catalyst engine in sub-phase B) is responsible for persisting the event,
 * deduping by ticker + first-buy-date, and applying quality gates.
 *
 * Pure function: takes the (already-filtered) list of purchases and the
 * window opts, returns a list of `ClusterEvent`s. Test fixtures pass in
 * txn arrays directly; the live caller pulls from the DB via
 * `listPurchasesSince` first.
 */

import type { InsiderTransaction } from '@vantage/db';

export type Conviction = 'HIGH' | 'MEDIUM' | 'LOW';

export interface ClusterInsider {
  insiderName: string;
  insiderTitle: string | null;
  shares: number;
  pricePerShare: number;
  valueUsd: number;
  transactionDate: Date;
}

export interface ClusterEvent {
  ticker: string;
  distinctInsiders: number;
  totalUsd: number;
  conviction: Conviction;
  insiders: ClusterInsider[];
  firstBuyDate: Date;
  lastBuyDate: Date;
  /** Number of insiders whose title hints at director / board membership. */
  directorCount: number;
}

export interface DetectClustersOptions {
  /** Window length in hours. Caller pre-filters; we re-filter defensively. */
  sinceHours: number;
  /** Distinct insider threshold for the MEDIUM tier. Default 3. */
  minInsiders?: number;
  /** Total USD threshold for the MEDIUM tier. Default $1M. */
  minTotalUsd?: number;
  /** USD floor for a single-insider LOW-tier cluster. Default $500k. */
  minSingleUsd?: number;
}

/**
 * Coerce a Decimal-like field from Prisma into a plain number. The runtime
 * value can be a Prisma.Decimal, a number, or a string depending on driver
 * config — `Number(x.toString())` covers all three with no precision loss
 * for the size of inputs we deal with (USD values < $1B).
 */
function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number(v);
  if (v && typeof (v as { toString?: () => string }).toString === 'function') {
    return Number((v as { toString: () => string }).toString());
  }
  return Number.NaN;
}

/**
 * Heuristic: does the insider title look like a director / board seat? We
 * use a simple keyword pass — Finnhub's title field is freeform and English
 * 99% of the time. Used to weight director-heavy clusters higher.
 */
function looksLikeDirector(title: string | null | undefined): boolean {
  if (!title) return false;
  const t = title.toLowerCase();
  return (
    t.includes('director') ||
    t.includes('board') ||
    t.includes('chair') ||
    t.includes('chairman') ||
    t.includes('chairwoman') ||
    t.includes('chairperson')
  );
}

/**
 * Group transactions by ticker and emit one ClusterEvent per ticker that
 * crosses a conviction threshold. Per-insider amounts are summed across
 * multiple buys in the window before the distinct-insider count is taken,
 * so a single insider with three same-day buys is still counted once.
 */
export function detectClusters(
  transactions: readonly InsiderTransaction[],
  opts: DetectClustersOptions,
): ClusterEvent[] {
  const minInsiders = opts.minInsiders ?? 3;
  const minTotalUsd = opts.minTotalUsd ?? 1_000_000;
  const minSingleUsd = opts.minSingleUsd ?? 500_000;
  const sinceMs = Date.now() - opts.sinceHours * 60 * 60 * 1000;

  // ticker → insiderName → aggregated row
  const perTicker = new Map<
    string,
    Map<
      string,
      {
        title: string | null;
        shares: number;
        valueUsd: number;
        latestPrice: number;
        latestDate: Date;
        firstDate: Date;
        directorish: boolean;
      }
    >
  >();

  for (const t of transactions) {
    if (t.transactionCode !== 'P') continue;
    const txnDate = t.transactionDate;
    if (!(txnDate instanceof Date) || Number.isNaN(txnDate.getTime())) continue;
    if (txnDate.getTime() < sinceMs) continue;

    const ticker = t.ticker.toUpperCase();
    const insiderName = (t.insiderName ?? '').trim();
    if (!insiderName) continue;

    const shares = toNumber(t.shares);
    const price = toNumber(t.pricePerShare);
    const valueUsd = toNumber(t.valueUsd);
    if (!Number.isFinite(shares) || shares <= 0) continue;
    if (!Number.isFinite(price) || price <= 0) continue;
    if (!Number.isFinite(valueUsd) || valueUsd <= 0) continue;

    let perInsider = perTicker.get(ticker);
    if (!perInsider) {
      perInsider = new Map();
      perTicker.set(ticker, perInsider);
    }
    const existing = perInsider.get(insiderName);
    if (existing) {
      existing.shares += shares;
      existing.valueUsd += valueUsd;
      existing.latestPrice = price;
      if (txnDate.getTime() > existing.latestDate.getTime()) {
        existing.latestDate = txnDate;
      }
      if (txnDate.getTime() < existing.firstDate.getTime()) {
        existing.firstDate = txnDate;
      }
      // Title is the most recent non-null we've seen.
      if (t.insiderTitle && !existing.title) {
        existing.title = t.insiderTitle;
        if (looksLikeDirector(t.insiderTitle)) existing.directorish = true;
      }
    } else {
      perInsider.set(insiderName, {
        title: t.insiderTitle ?? null,
        shares,
        valueUsd,
        latestPrice: price,
        latestDate: txnDate,
        firstDate: txnDate,
        directorish: looksLikeDirector(t.insiderTitle),
      });
    }
  }

  const events: ClusterEvent[] = [];
  for (const [ticker, perInsider] of perTicker.entries()) {
    if (perInsider.size === 0) continue;
    const insiderRows: ClusterInsider[] = [];
    let totalUsd = 0;
    let directorCount = 0;
    let firstBuy = Number.POSITIVE_INFINITY;
    let lastBuy = Number.NEGATIVE_INFINITY;
    for (const [name, row] of perInsider.entries()) {
      totalUsd += row.valueUsd;
      if (row.directorish) directorCount++;
      const ts = row.latestDate.getTime();
      const firstTs = row.firstDate.getTime();
      if (firstTs < firstBuy) firstBuy = firstTs;
      if (ts > lastBuy) lastBuy = ts;
      insiderRows.push({
        insiderName: name,
        insiderTitle: row.title,
        shares: row.shares,
        pricePerShare: row.latestPrice,
        valueUsd: row.valueUsd,
        transactionDate: row.latestDate,
      });
    }
    const distinctInsiders = perInsider.size;

    let conviction: Conviction | null = null;
    if (distinctInsiders >= minInsiders && totalUsd >= 2_000_000) {
      conviction = 'HIGH';
    } else if (distinctInsiders >= minInsiders || totalUsd >= minTotalUsd) {
      conviction = 'MEDIUM';
    } else if (distinctInsiders === 1) {
      const sole = insiderRows[0];
      if (sole && sole.valueUsd >= minSingleUsd) {
        conviction = 'LOW';
      }
    }
    // Director-heavy uplift: 3+ directors → at least MEDIUM (per spec 17.1
    // bullet "weight director-level higher").
    if (directorCount >= 3 && conviction === null) {
      conviction = 'MEDIUM';
    }
    if (!conviction) continue;

    events.push({
      ticker,
      distinctInsiders,
      totalUsd: Number(totalUsd.toFixed(2)),
      conviction,
      insiders: insiderRows.sort((a, b) => b.valueUsd - a.valueUsd),
      firstBuyDate: new Date(firstBuy),
      lastBuyDate: new Date(lastBuy),
      directorCount,
    });
  }

  // Stable order — highest conviction first, then largest dollars.
  const tier: Record<Conviction, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  events.sort((a, b) => {
    const t = tier[a.conviction] - tier[b.conviction];
    if (t !== 0) return t;
    return b.totalUsd - a.totalUsd;
  });
  return events;
}
