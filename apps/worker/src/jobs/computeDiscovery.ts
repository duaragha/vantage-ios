/**
 * Nightly discovery compute.
 *
 * POST /jobs/discover/compute, cron `0 18 * * 1-5` (6pm America/Toronto).
 * The worker also runs cached refreshes during the day; those reuse persisted
 * DailyBar + InsiderTransaction rows instead of sweeping external APIs.
 *
 * Steps:
 *   a. Load TickerUniverse filtered to marketCapUsd >= discoveryMinMcapUsd.
 *   b. Pull articles (30d window), earnings + 8K MarketEvents (30d),
 *      insider transactions (90d from Finnhub), price bars (20-day window),
 *      sector avg return — all per-ticker.
 *   c. Run computeDiscoveryScore from @vantage/core.
 *   d. Batch-write DiscoveryScore rows (all sharing the same computedAt
 *      so latestTopN can slice cleanly).
 *   e. Purge DiscoveryScore rows older than 30d.
 *
 * Rate-limit pacing: the per-ticker Finnhub insider-transactions call is
 * the bottleneck (60/min); for the full universe we chunk and pace via
 * the existing rate limiter that each adapter owns.
 *
 * Per-ticker failures are logged and skipped — a single rate-limit miss
 * shouldn't blow up the whole compute pass.
 */

import {
  prisma,
  getSettings,
  writeBatch,
  purgeOlderThan,
  type TickerUniverse,
  type Article,
  type MarketEvent,
} from '@vantage/db';
import {
  computeDiscoveryScore,
  coerceWeights,
  scoreHoldings,
  type Bar,
  type InsiderTxn,
  type ComputeDiscoveryScoreInput,
  type TickerMetricsLike,
} from '@vantage/core';
import { EventKind } from '@vantage/db';
import { getAlpaca, getFinnhub, getTiingo, getYFinance } from '../lib/adapters.js';
import type { FastifyBaseLogger } from 'fastify';
import { normalizeStoredDiscoveryMetrics } from '../lib/discoveryMetrics.js';

export interface ComputeDiscoveryOptions {
  /**
   * Override the universe with an explicit ticker list. Used by smoke tests
   * to bound the compute to a handful of fixture tickers.
   */
  tickers?: readonly string[];
  /**
   * Skip per-ticker Finnhub/Tiingo lookups — callers pre-stage all the data
   * in `fixtures` below. Used by smoke tests.
   */
  fixtures?: Map<
    string,
    {
      insiderTxns: readonly InsiderTxn[];
      recentBars: readonly Bar[];
      sectorAvgReturn: number;
    }
  >;
  /** Cap the number of tickers processed even when `tickers` is omitted. */
  limit?: number;
  /**
   * Use persisted DailyBar + InsiderTransaction rows instead of per-ticker
   * Finnhub/Tiingo calls. Cheap enough for intraday refreshes; the full 6pm
   * run still refreshes the external data once per day.
   */
  useCachedMarketData?: boolean;
}

export interface ComputeDiscoveryResult {
  universeSize: number;
  scored: number;
  failed: number;
  purged: number;
  holdingsScored: number;
  runtimeMs: number;
  computedAt: string;
}

/**
 * Pull insider transactions for a ticker and coerce to InsiderTxn[].
 * Finnhub's getInsiderTransactions returns raw Form-4 data with `share`
 * (delta), `transactionPrice`, and `transactionCode`. We multiply share×price
 * to get USD value; positive for buys ('P') and ignore anything else (we
 * treat 'S' — open-market sales — as negative valueUsd via negative share).
 */
async function fetchInsiderTxnsForTicker(ticker: string): Promise<InsiderTxn[]> {
  const fn = getFinnhub();
  const raw = await fn.getInsiderTransactions(ticker);
  const out: InsiderTxn[] = [];
  for (const t of raw) {
    const date = new Date(t.transactionDate);
    if (Number.isNaN(date.getTime())) continue;
    const price = Number(t.transactionPrice);
    const shareDelta = Number(t.change ?? t.share);
    if (!Number.isFinite(price) || !Number.isFinite(shareDelta)) continue;
    // Sign convention: Finnhub's `change` is signed already (positive buy,
    // negative sell). `share` is unsigned so fall through cautiously.
    const valueUsd = price * shareDelta;
    out.push({ valueUsd, transactionDate: date });
  }
  return out;
}

async function fetchBarsForTicker(
  ticker: string,
  log: FastifyBaseLogger | Console,
): Promise<Bar[]> {
  const end = new Date();
  const start = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  try {
    const isCanadian = /\.(TO|NE|V)$/i.test(ticker);
    const bars = isCanadian
      ? await getYFinance().getDailyBars(ticker, start, end)
      : await getAlpaca().getBars(ticker, '1Day', start, end);
    if (bars.length > 0) {
      return bars.map((b) => ({ date: b.timestamp, close: b.close }));
    }
    if (isCanadian) return [];
    const fallback = await getTiingo().getDailyPrices(ticker, start, end);
    return fallback.map((b) => ({ date: b.timestamp, close: b.close }));
  } catch (err) {
    log.warn?.(
      { ticker, err: err instanceof Error ? err.message : err },
      'compute.discovery: bars fetch failed',
    );
    return [];
  }
}

async function fetchUsBarsForTickers(
  tickers: readonly string[],
  log: FastifyBaseLogger | Console,
): Promise<Map<string, Bar[]>> {
  if (tickers.length === 0) return new Map();
  try {
    const end = new Date();
    const start = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const rows = await getAlpaca().getMultiBars(tickers, '1Day', start, end);
    const out = new Map<string, Bar[]>();
    for (const [ticker, bars] of rows) {
      out.set(
        ticker.toUpperCase(),
        bars.map((bar) => ({ date: bar.timestamp, close: bar.close })),
      );
    }
    log.info?.(
      { requested: tickers.length, returned: out.size },
      'compute.discovery: Alpaca batch bars loaded',
    );
    return out;
  } catch (err) {
    log.warn?.(
      { tickerCount: tickers.length, err: err instanceof Error ? err.message : err },
      'compute.discovery: Alpaca batch bars failed; using stored bars',
    );
    return new Map();
  }
}

async function loadCachedInsidersByTicker(
  symbols: readonly string[],
  since: Date,
): Promise<Map<string, InsiderTxn[]>> {
  const out = new Map<string, InsiderTxn[]>();
  if (symbols.length === 0) return out;
  const upper = Array.from(new Set(symbols.map((s) => s.toUpperCase())));
  const rows = await prisma.insiderTransaction.findMany({
    where: {
      ticker: { in: upper },
      transactionDate: { gte: since },
      transactionCode: 'P',
    },
    select: {
      ticker: true,
      transactionDate: true,
      valueUsd: true,
    },
    orderBy: { transactionDate: 'asc' },
  });
  for (const row of rows) {
    const ticker = row.ticker.toUpperCase();
    const arr = out.get(ticker) ?? [];
    arr.push({
      valueUsd: Number(row.valueUsd),
      transactionDate: row.transactionDate,
    });
    out.set(ticker, arr);
  }
  return out;
}

async function loadCachedBarsByTicker(
  symbols: readonly string[],
  since: Date,
): Promise<Map<string, Bar[]>> {
  const out = new Map<string, Bar[]>();
  if (symbols.length === 0) return out;
  const upper = Array.from(new Set(symbols.map((s) => s.toUpperCase())));
  const rows = await prisma.dailyBar.findMany({
    where: {
      ticker: { in: upper },
      date: { gte: since },
    },
    select: {
      ticker: true,
      date: true,
      close: true,
    },
    orderBy: [{ ticker: 'asc' }, { date: 'asc' }],
  });
  for (const row of rows) {
    const ticker = row.ticker.toUpperCase();
    const arr = out.get(ticker) ?? [];
    arr.push({
      date: row.date,
      close: Number(row.close),
    });
    out.set(ticker, arr);
  }
  return out;
}

/**
 * Bulk-fetch TickerMetrics rows for the supplied symbols and project them
 * onto the TickerMetricsLike shape the score functions expect. Market cap is
 * coerced to a plain number; stored percentage points are converted to decimal
 * ratios. Multiples and debt/equity stay in their native units. Symbols missing
 * from the table simply aren't present in the returned map.
 */
async function loadMetricsByTicker(
  symbols: readonly string[],
): Promise<Map<string, TickerMetricsLike>> {
  const out = new Map<string, TickerMetricsLike>();
  if (symbols.length === 0) return out;
  const rows = await prisma.tickerMetrics.findMany({
    where: { ticker: { in: symbols.map((s) => s.toUpperCase()) } },
  });
  for (const m of rows) {
    out.set(
      m.ticker.toUpperCase(),
      normalizeStoredDiscoveryMetrics({
        peTtm: m.peTtm,
        pegTtm: m.pegTtm,
        psTtm: m.psTtm,
        pbTtm: m.pbTtm,
        evToEbitda: m.evToEbitda,
        roeTtm: m.roeTtm,
        roicTtm: m.roicTtm,
        roaTtm: m.roaTtm,
        grossMarginTtm: m.grossMarginTtm,
        operatingMarginTtm: m.operatingMarginTtm,
        netMarginTtm: m.netMarginTtm,
        debtToEquity: m.debtToEquity,
        currentRatio: m.currentRatio,
        revenueGrowthYoy: m.revenueGrowthYoy,
        revenueGrowth5y: m.revenueGrowth5y,
        epsGrowthYoy: m.epsGrowthYoy,
        epsGrowth5y: m.epsGrowth5y,
        marketCapUsd: m.marketCapUsd ? Number(m.marketCapUsd) : null,
        avgDollarVolume30d: m.avgDollarVolume30d,
      }),
    );
  }
  return out;
}

/**
 * Compute sector-average 20-day returns on the fly. We group the per-ticker
 * bar fetches by sector and simple-average their total returns. Called once
 * after the per-ticker bar sweep.
 */
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

export async function computeDiscovery(
  log: FastifyBaseLogger | Console = console,
  opts: ComputeDiscoveryOptions = {},
): Promise<ComputeDiscoveryResult> {
  const started = Date.now();
  const settings = await getSettings();
  const minMcap = settings?.discoveryMinMcapUsd
    ? Number(settings.discoveryMinMcapUsd)
    : 500_000_000;
  const weightsOverride = settings?.discoveryWeights
    ? coerceWeights(settings.discoveryWeights)
    : {};

  // --- Step 1: universe selection ----------------------------------------
  // Default behavior: score the top-1000 USD/CAD non-lottery tickers by
  // market cap. Drives discovery against the broader market rather than
  // only news-mentioned names so the engine can surface stocks that the
  // news pipeline hasn't picked up. Held tickers are scored separately by
  // scoreHoldings (Step 4) and excluded here to avoid duplicate rows in
  // the same DiscoveryScore batch. An explicit `opts.tickers` override
  // bypasses all of this for smoke tests / manual triggers.
  // Runtime expectation: ~1000 tickers × per-ticker Finnhub insider call
  // (~60/min free-tier limit) puts the job at roughly 30-60 minutes.
  // Acceptable for the once-daily 6pm cron.
  let universe: TickerUniverse[];
  if (opts.tickers && opts.tickers.length > 0) {
    const upper = opts.tickers.map((t) => t.toUpperCase());
    universe = await prisma.tickerUniverse.findMany({
      where: { symbol: { in: upper } },
    });
  } else {
    const [held, candidates] = await Promise.all([
      prisma.position.findMany({
        where: { closedAt: null },
        select: { ticker: true },
      }),
      prisma.tickerUniverse.findMany({
        where: {
          currency: { in: ['USD', 'CAD'] },
          isLottery: false,
          marketCapUsd: { gte: minMcap },
        },
        orderBy: { marketCapUsd: 'desc' },
        take: 1000,
      }),
    ]);
    const heldSet = new Set(held.map((r) => r.ticker.toUpperCase()));
    universe = candidates.filter((u) => !heldSet.has(u.symbol.toUpperCase()));
  }
  if (opts.limit) universe = universe.slice(0, opts.limit);
  log.info?.(
    {
      universeSize: universe.length,
      minMcap,
      override: !!opts.tickers,
      cachedMarketData: opts.useCachedMarketData === true,
    },
    'compute.discovery: universe sized',
  );

  // --- Step 2a: fetch articles, earnings events, 8K events (bulk) -------
  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const tickers = universe.map((u) => u.symbol);
  if (tickers.length === 0) {
    // Even with an empty universe we still want to score held positions so
    // the /compare view has apples-to-apples data.
    let holdingsScored = 0;
    const sharedComputedAt = new Date();
    try {
      const heldRows = await prisma.position.findMany({
        where: { closedAt: null },
        select: { ticker: true },
      });
      const heldTickers = Array.from(new Set(heldRows.map((row) => row.ticker.toUpperCase())));
      const heldMetrics = await loadMetricsByTicker(heldTickers);
      const cachedSince = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      const cachedBarsSince = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
      const [heldCachedInsiders, heldCachedBars] = opts.fixtures
        ? [new Map<string, InsiderTxn[]>(), new Map<string, Bar[]>()]
        : await Promise.all([
            loadCachedInsidersByTicker(heldTickers, cachedSince),
            loadCachedBarsByTicker(heldTickers, cachedBarsSince),
          ]);
      const holdings = await scoreHoldings({
        log,
        fixtures: opts.fixtures,
        fetchInsiderTxns: opts.useCachedMarketData
          ? async (ticker) => heldCachedInsiders.get(ticker.toUpperCase()) ?? []
          : async (ticker) => {
              try {
                const fetched = await fetchInsiderTxnsForTicker(ticker);
                if (fetched.length > 0) return fetched;
              } catch (err) {
                log.warn?.(
                  { ticker, err: err instanceof Error ? err.message : err },
                  'compute.discovery: holding insider fetch failed; using stored data',
                );
              }
              return heldCachedInsiders.get(ticker.toUpperCase()) ?? [];
            },
        fetchRecentBars: opts.useCachedMarketData
          ? async (ticker) => heldCachedBars.get(ticker.toUpperCase()) ?? []
          : async (ticker) => {
              const fetched = await fetchBarsForTicker(ticker, log);
              return fetched.length > 0
                ? fetched
                : (heldCachedBars.get(ticker.toUpperCase()) ?? []);
            },
        computedAt: sharedComputedAt,
        metricsByTicker: heldMetrics,
      });
      holdingsScored = holdings.written;
    } catch (err) {
      log.warn?.(
        { err: err instanceof Error ? err.message : err },
        'compute.discovery: scoreHoldings failed (empty universe) — continuing',
      );
    }
    return {
      universeSize: 0,
      scored: 0,
      failed: 0,
      purged: await purgeOlderThan(30),
      holdingsScored,
      runtimeMs: Date.now() - started,
      computedAt: new Date().toISOString(),
    };
  }

  // Pre-fetch metrics for the universe AND held positions in one pass so the
  // per-ticker loop and the downstream scoreHoldings call both see the same
  // cohort. CA tickers and any name without a TickerMetrics row simply miss
  // from the map; the score functions floor those signals to 0.
  const heldForMetrics = await prisma.position.findMany({
    where: { closedAt: null },
    select: { ticker: true },
  });
  const metricsScope = Array.from(
    new Set([
      ...tickers.map((t) => t.toUpperCase()),
      ...heldForMetrics.map((r) => r.ticker.toUpperCase()),
    ]),
  );
  const metricsByTicker = await loadMetricsByTicker(metricsScope);
  log.info?.(
    { withMetrics: metricsByTicker.size, total: tickers.length },
    'compute.discovery: metrics loaded',
  );

  const [articles, events] = await Promise.all([
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
  ]);

  // Bucket per ticker for O(1) lookups in the inner loop.
  const articlesByTicker = new Map<string, Article[]>();
  for (const a of articles) {
    for (const t of a.tickers) {
      const key = t.toUpperCase();
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

  // --- Step 2b: per-ticker insider + bars (fixture-overrideable) --------
  const insidersByTicker = new Map<string, InsiderTxn[]>();
  const barsByTicker = new Map<string, Bar[]>();
  const sectorByTicker = new Map<string, string | null>();

  for (const u of universe) {
    sectorByTicker.set(u.symbol, u.sector ?? null);
  }

  const cachedSince = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const cachedBarsSince = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
  // Persisted transactions are also a fallback for a full pass. Finnhub uses
  // the same empty-array shape for "no transactions" and some soft failures;
  // a known purchase from the last 90 days must not disappear from the score
  // merely because tonight's request missed.
  const cachedInsidersPromise = !opts.fixtures
    ? loadCachedInsidersByTicker(metricsScope, cachedSince)
    : Promise.resolve(new Map<string, InsiderTxn[]>());
  // Stored bars are also the fallback for any US symbol the Alpaca batch does
  // not return. Loading once prevents a provider miss from turning back into
  // hundreds of Tiingo calls and breaching its unique-symbol quota.
  const cachedBarsPromise = !opts.fixtures
    ? loadCachedBarsByTicker(metricsScope, cachedBarsSince)
    : Promise.resolve(new Map<string, Bar[]>());
  const [cachedInsiders, cachedBars] = await Promise.all([
    cachedInsidersPromise,
    cachedBarsPromise,
  ]);

  if (opts.fixtures) {
    for (const u of universe) {
      const fx = opts.fixtures.get(u.symbol.toUpperCase());
      insidersByTicker.set(u.symbol, fx?.insiderTxns ? [...fx.insiderTxns] : []);
      barsByTicker.set(u.symbol, fx?.recentBars ? [...fx.recentBars] : []);
    }
  } else if (opts.useCachedMarketData) {
    for (const u of universe) {
      const ticker = u.symbol.toUpperCase();
      insidersByTicker.set(u.symbol, cachedInsiders.get(ticker) ?? []);
      barsByTicker.set(u.symbol, cachedBars.get(ticker) ?? []);
    }
  } else {
    const usBars = await fetchUsBarsForTickers(
      universe.filter((row) => row.currency !== 'CAD').map((row) => row.symbol),
      log,
    );
    let freshBarTickers = 0;
    let storedBarFallbacks = 0;
    let missingBarTickers = 0;
    let storedInsiderFallbacks = 0;
    for (const u of universe) {
      const ticker = u.symbol.toUpperCase();
      const cachedTxns = cachedInsiders.get(ticker) ?? [];
      let fetchedTxns: InsiderTxn[] = [];
      try {
        fetchedTxns = await fetchInsiderTxnsForTicker(u.symbol);
      } catch (err) {
        log.warn?.(
          { ticker: u.symbol, err: err instanceof Error ? err.message : err },
          'compute.discovery: insider fetch failed; using stored data',
        );
      }
      const txns = fetchedTxns.length > 0 ? fetchedTxns : cachedTxns;
      if (fetchedTxns.length === 0 && cachedTxns.length > 0) storedInsiderFallbacks++;

      const fetchedBars =
        u.currency === 'CAD' ? await fetchBarsForTicker(u.symbol, log) : (usBars.get(ticker) ?? []);
      const cachedTickerBars = cachedBars.get(ticker) ?? [];
      const bars = fetchedBars.length > 0 ? fetchedBars : cachedTickerBars;
      if (fetchedBars.length > 0) freshBarTickers++;
      else if (cachedTickerBars.length > 0) storedBarFallbacks++;
      else missingBarTickers++;

      insidersByTicker.set(u.symbol, txns);
      barsByTicker.set(u.symbol, bars);
    }
    log.info?.(
      {
        freshBarTickers,
        storedBarFallbacks,
        missingBarTickers,
        storedInsiderFallbacks,
      },
      'compute.discovery: provider coverage',
    );
  }

  // --- Step 2c: sector averages -----------------------------------------
  const sectorAverages = opts.fixtures
    ? new Map<string, number>() // fixtures provide sectorAvgReturn directly
    : computeSectorAverages(barsByTicker, sectorByTicker);

  // --- Step 3: compute + batch-write ------------------------------------
  const computedAt = new Date();
  const rows: Array<{
    ticker: string;
    score: number;
    signalBreakdown: ReturnType<typeof computeDiscoveryScore>['breakdown'];
  }> = [];
  let failed = 0;

  for (const u of universe) {
    try {
      const ticker = u.symbol;
      const tickerArticles = articlesByTicker.get(ticker) ?? [];
      const tier3Articles = tickerArticles.filter((a) => a.sourceTier === 3);
      const sector = u.sector ?? null;
      const sectorAvg = opts.fixtures
        ? (opts.fixtures.get(ticker)?.sectorAvgReturn ?? 0)
        : sector
          ? (sectorAverages.get(sector) ?? 0)
          : 0;

      const input: ComputeDiscoveryScoreInput = {
        articles: tickerArticles,
        earningsEvents: earningsByTicker.get(ticker) ?? [],
        insiderTxns: insidersByTicker.get(ticker) ?? [],
        filings8K: filings8KByTicker.get(ticker) ?? [],
        recentBars: barsByTicker.get(ticker) ?? [],
        sectorAvgReturn: sectorAvg,
        tier3Articles,
        metrics: metricsByTicker.get(ticker.toUpperCase()) ?? null,
        weights: weightsOverride,
      };
      const result = computeDiscoveryScore(input);
      rows.push({
        ticker,
        score: result.score,
        signalBreakdown: result.breakdown,
      });
    } catch (err) {
      failed++;
      log.warn?.(
        { ticker: u.symbol, err: err instanceof Error ? err.message : err },
        'compute.discovery: per-ticker score failed',
      );
    }
  }

  const scored = await writeBatch(
    rows.map((r) => ({
      ticker: r.ticker,
      score: r.score,
      signalBreakdown: r.signalBreakdown as unknown as Parameters<
        typeof writeBatch
      >[0][number]['signalBreakdown'],
    })),
    computedAt,
  );

  // --- Step 4: score held positions (apples-to-apples with candidates) --
  let holdingsScored = 0;
  try {
    const holdings = await scoreHoldings({
      log,
      fixtures: opts.fixtures,
      fetchInsiderTxns: opts.useCachedMarketData
        ? async (ticker) => cachedInsiders.get(ticker.toUpperCase()) ?? []
        : async (ticker) => {
            try {
              const fetched = await fetchInsiderTxnsForTicker(ticker);
              if (fetched.length > 0) return fetched;
            } catch (err) {
              log.warn?.(
                { ticker, err: err instanceof Error ? err.message : err },
                'compute.discovery: holding insider fetch failed; using stored data',
              );
            }
            return cachedInsiders.get(ticker.toUpperCase()) ?? [];
          },
      fetchRecentBars: opts.useCachedMarketData
        ? async (ticker) => cachedBars.get(ticker.toUpperCase()) ?? []
        : async (ticker) => {
            const fetched = await fetchBarsForTicker(ticker, log);
            return fetched.length > 0 ? fetched : (cachedBars.get(ticker.toUpperCase()) ?? []);
          },
      computedAt,
      metricsByTicker,
    });
    holdingsScored = holdings.written;
  } catch (err) {
    log.warn?.(
      { err: err instanceof Error ? err.message : err },
      'compute.discovery: scoreHoldings failed — continuing',
    );
  }

  // --- Step 5: purge old rows -------------------------------------------
  const purged = await purgeOlderThan(30);

  const result: ComputeDiscoveryResult = {
    universeSize: universe.length,
    scored,
    failed,
    purged,
    holdingsScored,
    runtimeMs: Date.now() - started,
    computedAt: computedAt.toISOString(),
  };
  log.info?.(result, 'compute.discovery: done');
  return result;
}
