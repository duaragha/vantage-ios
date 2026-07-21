/**
 * scoreHoldings — score open Positions with the same discovery engine used
 * for unheld universe candidates, so the /compare view can rank held vs
 * market candidates on a single axis.
 *
 * Reuses `computeDiscoveryScore` from signals.ts. Pulls the same 30d/90d
 * windows as the nightly compute job (articles, earnings, 8-Ks, insider txns,
 * 20-day bars). Reads the latest price snapshot via the shared priceOracle so
 * the compare page can display 20-day returns without re-fetching.
 *
 * Writes results to the existing DiscoveryScore table (no schema change).
 * The /compare loader tells held from unheld rows by joining against
 * Position.ticker — no extra column needed.
 *
 * Pure-ish: no LLM calls, no Telegram, no mutations other than the batch
 * DiscoveryScore insert. Price lookups go through the in-memory-cached
 * priceOracle, so a tight page refresh doesn't hammer upstreams.
 */

import {
  prisma,
  getSettings,
  writeBatch,
  EventKind,
  type ThesisStatus,
  type Article,
  type MarketEvent,
  type Thesis,
} from '@vantage/db';

import {
  computeDiscoveryScore,
  coerceWeights,
  type Bar,
  type InsiderTxn,
  type SignalBreakdown,
  type TickerMetricsLike,
} from './signals.js';
import { getPriceOracle, type PriceOracle } from '../rebalance/priceOracle.js';
import { aggregatePositionsByTicker } from '../portfolio/aggregate.js';
import { getUsdCadRate } from '../fx.js';
import { nativeAmountToUsd } from '../portfolio/valuation.js';

export interface ScoreHoldingsLogger {
  info?: (obj: unknown, msg?: string) => void;
  warn?: (obj: unknown, msg?: string) => void;
  debug?: (obj: unknown, msg?: string) => void;
}

export interface ScoreHoldingsOptions {
  /** Override for tests. When present, no Finnhub/Tiingo calls are made. */
  fixtures?: Map<
    string,
    {
      insiderTxns: readonly InsiderTxn[];
      recentBars: readonly Bar[];
      sectorAvgReturn?: number;
    }
  >;
  /** Skip the DiscoveryScore insert (tests that only want the return value). */
  skipWrite?: boolean;
  /** Override the price oracle (tests). */
  priceOracle?: PriceOracle;
  /** Adapter injection points so @vantage/core stays dep-light. */
  fetchInsiderTxns?: (ticker: string) => Promise<InsiderTxn[]>;
  fetchRecentBars?: (ticker: string) => Promise<Bar[]>;
  /**
   * Share the parent compute's batch timestamp so held + unheld rows land in
   * the same `max(computedAt)` cohort on the DiscoveryScore table. Without
   * this, scoreHoldings writes a slightly later timestamp and the dashboard's
   * `max(computedAt)` query only sees the held rows.
   */
  computedAt?: Date;
  /**
   * Pre-fetched fundamentals keyed by uppercase ticker. The orchestrator
   * (computeDiscovery.ts) loads metrics for held + universe tickers in a
   * single bulk query; held names that miss from the map score 0 on the
   * fundamentals signals, same as standalone callers passing nothing.
   */
  metricsByTicker?: Map<string, TickerMetricsLike>;
  log?: ScoreHoldingsLogger;
}

export interface HoldingScoreRow {
  ticker: string;
  name: string | null;
  sector: string | null;
  score: number;
  breakdown: SignalBreakdown;
  thesisStatus: ThesisStatus | null;
  sharesHeld: number;
  avgCost: number;
  priceNow: number | null;
  twentyDayReturnPct: number | null;
  valueUsd: number | null;
  computedAt: string;
}

export interface ScoreHoldingsResult {
  scored: number;
  written: number;
  skipped: number;
  runtimeMs: number;
  computedAt: string;
  rows: HoldingScoreRow[];
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Compute discovery scores for every open Position and optionally persist
 * them to the DiscoveryScore table.
 */
export async function scoreHoldings(opts: ScoreHoldingsOptions = {}): Promise<ScoreHoldingsResult> {
  const started = Date.now();
  const log = opts.log;

  const [settings, positions] = await Promise.all([
    getSettings(),
    prisma.position.findMany({
      where: { closedAt: null },
      include: { thesis: true, account: true },
      orderBy: { ticker: 'asc' },
    }),
  ]);

  const computedAt = opts.computedAt ?? new Date();

  if (positions.length === 0) {
    log?.info?.({}, '[scoreHoldings] no open positions — nothing to score');
    return {
      scored: 0,
      written: 0,
      skipped: 0,
      runtimeMs: Date.now() - started,
      computedAt: computedAt.toISOString(),
      rows: [],
    };
  }

  const weightsOverride = settings?.discoveryWeights
    ? coerceWeights(settings.discoveryWeights)
    : {};

  // Same ticker may exist in multiple accounts (TFSA + RRSP) — discovery
  // scoring is ticker-keyed, so dedupe before signal fetches and emit one
  // score row per ticker with combined shares + weighted avg cost.
  const tickers = Array.from(new Set(positions.map((p) => p.ticker.toUpperCase())));
  const since30d = new Date(Date.now() - THIRTY_DAYS_MS);

  // --- Bulk DB fetches (articles, events, universe) ---------------------
  const [articles, events, universe] = await Promise.all([
    prisma.article.findMany({
      where: {
        publishedAt: { gte: since30d },
        tickers: { hasSome: tickers },
      },
    }),
    prisma.marketEvent.findMany({
      where: {
        occurredAt: { gte: since30d },
        ticker: { in: tickers },
        kind: { in: [EventKind.Earnings, EventKind.Filing8K] },
      },
    }),
    prisma.tickerUniverse.findMany({
      where: { symbol: { in: tickers } },
      select: { symbol: true, name: true, sector: true },
    }),
  ]);

  const universeBySymbol = new Map<string, { name: string | null; sector: string | null }>();
  for (const u of universe) {
    universeBySymbol.set(u.symbol.toUpperCase(), {
      name: u.name,
      sector: u.sector,
    });
  }

  const articlesByTicker = new Map<string, Article[]>();
  for (const a of articles) {
    for (const t of a.tickers) {
      const key = t.toUpperCase();
      if (!tickers.includes(key)) continue;
      const arr = articlesByTicker.get(key) ?? [];
      arr.push(a);
      articlesByTicker.set(key, arr);
    }
  }

  const earningsByTicker = new Map<string, MarketEvent[]>();
  const filings8KByTicker = new Map<string, MarketEvent[]>();
  for (const e of events) {
    if (!e.ticker) continue;
    const key = e.ticker.toUpperCase();
    if (e.kind === EventKind.Earnings) {
      const arr = earningsByTicker.get(key) ?? [];
      arr.push(e);
      earningsByTicker.set(key, arr);
    } else if (e.kind === EventKind.Filing8K) {
      const arr = filings8KByTicker.get(key) ?? [];
      arr.push(e);
      filings8KByTicker.set(key, arr);
    }
  }

  // --- Per-ticker insider + bars (fixture-overrideable) -----------------
  const insidersByTicker = new Map<string, InsiderTxn[]>();
  const barsByTicker = new Map<string, Bar[]>();

  for (const ticker of tickers) {
    const fx = opts.fixtures?.get(ticker);
    if (fx) {
      insidersByTicker.set(ticker, [...fx.insiderTxns]);
      barsByTicker.set(ticker, [...fx.recentBars]);
      continue;
    }
    let txns: InsiderTxn[] = [];
    let bars: Bar[] = [];
    try {
      if (opts.fetchInsiderTxns) {
        txns = await opts.fetchInsiderTxns(ticker);
      }
    } catch (err) {
      log?.warn?.(
        { ticker, err: err instanceof Error ? err.message : err },
        '[scoreHoldings] insider fetch failed',
      );
    }
    try {
      if (opts.fetchRecentBars) {
        bars = await opts.fetchRecentBars(ticker);
      }
    } catch (err) {
      log?.warn?.(
        { ticker, err: err instanceof Error ? err.message : err },
        '[scoreHoldings] bars fetch failed',
      );
    }
    insidersByTicker.set(ticker, txns);
    barsByTicker.set(ticker, bars);
  }

  // Sector average return across the held cohort only. It's noisier than
  // the nightly universe-wide value but consistent within a single compute.
  const sectorAverages = computeSectorAverages(
    barsByTicker,
    new Map(Array.from(universeBySymbol.entries()).map(([k, v]) => [k, v.sector])),
  );

  // --- Price snapshots (for 20-day returns + valueUsd) -------------------
  const oracle = opts.priceOracle ?? getPriceOracle();
  const [priceRecord, usdCadRate] = await Promise.all([
    oracle.getLatestPrices(tickers),
    getUsdCadRate(),
  ]);

  // --- Aggregate per ticker (positions table is keyed by accountId+ticker) ---
  // Collapse multi-account holdings of the same ticker into a single scoring
  // unit. Shares sum; avgCost becomes share-weighted. Thesis is picked from
  // the first lot that has one — same ticker in two accounts typically shares
  // a thesis in practice, and if it doesn't we still surface a non-null
  // status so the /compare page renders meaningfully.
  const aggregated = aggregatePositionsByTicker(
    positions.map((p) => ({
      ticker: p.ticker.toUpperCase(),
      shares: Number(p.shares),
      avgCost: Number(p.avgCost),
      account: { id: p.account.id, type: p.account.type },
    })),
  );
  const sectorByTicker = new Map<string, string | null>();
  const thesisByTicker = new Map<string, Thesis | null>();
  for (const p of positions) {
    const key = p.ticker.toUpperCase();
    if (!sectorByTicker.has(key) || (sectorByTicker.get(key) == null && p.sector)) {
      sectorByTicker.set(key, p.sector);
    }
    if (p.thesis && !thesisByTicker.get(key)) {
      thesisByTicker.set(key, p.thesis);
    } else if (!thesisByTicker.has(key)) {
      thesisByTicker.set(key, null);
    }
  }

  // --- Score, shape rows, optionally persist -----------------------------
  const rows: HoldingScoreRow[] = [];
  const writeRows: Array<{
    ticker: string;
    score: number;
    signalBreakdown: SignalBreakdown;
  }> = [];
  let skipped = 0;

  for (const agg of aggregated) {
    try {
      const ticker = agg.ticker;
      const meta = universeBySymbol.get(ticker) ?? null;
      const sector = meta?.sector ?? sectorByTicker.get(ticker) ?? null;
      const tickerArticles = articlesByTicker.get(ticker) ?? [];
      const tier3Articles = tickerArticles.filter((a) => a.sourceTier === 3);
      const sectorAvg = sector ? (sectorAverages.get(sector) ?? 0) : 0;
      const bars = barsByTicker.get(ticker) ?? [];

      const result = computeDiscoveryScore({
        articles: tickerArticles,
        earningsEvents: earningsByTicker.get(ticker) ?? [],
        insiderTxns: insidersByTicker.get(ticker) ?? [],
        filings8K: filings8KByTicker.get(ticker) ?? [],
        recentBars: bars,
        sectorAvgReturn: sectorAvg,
        tier3Articles,
        metrics: opts.metricsByTicker?.get(ticker) ?? null,
        weights: weightsOverride,
      });

      const priceResult = priceRecord[ticker];
      const priceNow = priceResult?.price ?? null;
      const twentyDayReturnPct = compute20dReturnPct(bars);
      const shares = agg.totalShares;
      const valueUsd =
        priceNow !== null && Number.isFinite(priceNow)
          ? nativeAmountToUsd(shares * priceNow, priceResult?.currency ?? 'USD', usdCadRate)
          : null;

      rows.push({
        ticker,
        name: meta?.name ?? null,
        sector,
        score: result.score,
        breakdown: result.breakdown,
        thesisStatus: extractThesisStatus(thesisByTicker.get(ticker) ?? null),
        sharesHeld: shares,
        avgCost: agg.weightedAvgCost,
        priceNow,
        twentyDayReturnPct,
        valueUsd,
        computedAt: computedAt.toISOString(),
      });

      writeRows.push({
        ticker,
        score: result.score,
        signalBreakdown: result.breakdown,
      });
    } catch (err) {
      skipped++;
      log?.warn?.(
        {
          ticker: agg.ticker,
          err: err instanceof Error ? err.message : err,
        },
        '[scoreHoldings] per-ticker score failed',
      );
    }
  }

  let written = 0;
  if (!opts.skipWrite && writeRows.length > 0) {
    written = await writeBatch(
      writeRows.map((r) => ({
        ticker: r.ticker,
        score: r.score,
        signalBreakdown: r.signalBreakdown as unknown as Parameters<
          typeof writeBatch
        >[0][number]['signalBreakdown'],
      })),
      computedAt,
    );
  }

  const result: ScoreHoldingsResult = {
    scored: rows.length,
    written,
    skipped,
    runtimeMs: Date.now() - started,
    computedAt: computedAt.toISOString(),
    rows,
  };
  log?.info?.(
    {
      scored: result.scored,
      written: result.written,
      skipped: result.skipped,
      runtimeMs: result.runtimeMs,
    },
    '[scoreHoldings] done',
  );
  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractThesisStatus(thesis: Thesis | null | undefined): ThesisStatus | null {
  if (!thesis) return null;
  return thesis.status;
}

/**
 * 20-day total return from the earliest to the latest bar in the supplied
 * window. We trust the caller to have fetched ~30d of bars; we pick the
 * first/last and compute a single return. Returns null when <2 bars.
 */
function compute20dReturnPct(bars: readonly Bar[]): number | null {
  if (bars.length < 2) return null;
  const sorted = [...bars].sort((a, b) => a.date.getTime() - b.date.getTime());
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last || first.close <= 0) return null;
  const pct = ((last.close - first.close) / first.close) * 100;
  return Number.isFinite(pct) ? pct : null;
}

function computeSectorAverages(
  perTickerBars: Map<string, Bar[]>,
  perTickerSector: Map<string, string | null>,
): Map<string, number> {
  const buckets = new Map<string, number[]>();
  for (const [ticker, bars] of perTickerBars.entries()) {
    if (bars.length < 2) continue;
    const sector = perTickerSector.get(ticker);
    if (!sector) continue;
    const sorted = [...bars].sort((a, b) => a.date.getTime() - b.date.getTime());
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    if (!first || !last || first.close <= 0) continue;
    const r = (last.close - first.close) / first.close;
    const arr = buckets.get(sector) ?? [];
    arr.push(r);
    buckets.set(sector, arr);
  }
  const out = new Map<string, number>();
  for (const [sector, returns] of buckets.entries()) {
    if (returns.length === 0) continue;
    const avg = returns.reduce((a, b) => a + b, 0) / returns.length;
    out.set(sector, avg);
  }
  return out;
}
