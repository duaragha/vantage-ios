/**
 * Poll adjusted EOD daily bars for every ticker with signal.
 *
 * Scope: SPY benchmark + held positions + watchlist + the day-trade scanner universe (the
 * liquidity-floor names the scanner can rank) + any ticker with an article in
 * the last 30d (same set the discovery compute scores). For each one we pull
 * the last 540 calendar days, enough for the 52-week range and one-year return
 * windows on Compare. Once a ticker has at least 252 bars, normal runs refresh
 * only the last 14 days; a missed poll is filled by the next overlap window.
 *
 * Bars are persisted via `upsertBars` keyed on (ticker, date), so reruns are
 * idempotent and the table doesn't grow linearly with cron ticks.
 *
 * US history uses Alpaca's multi-symbol endpoint in 100-symbol chunks. Canadian
 * listings use Yahoo Finance because Alpaca has no TSX/NEO/TSX-V coverage.
 * Tiingo is a bounded fallback for US symbols Alpaca omits, preserving its
 * 500-unique-symbol/hour quota for actual gaps instead of spending it on the
 * entire scanner universe.
 */

import { prisma, upsertBars } from '@vantage/db';
import { getAlpaca, getTiingo, getYFinance } from '../lib/adapters.js';
import { requiresFullHistory, type BarCoverage } from '../lib/eodHistory.js';
import type { FastifyBaseLogger } from 'fastify';
import type { NormalizedBar } from '@vantage/sources';

export interface PollEodResult {
  tickersPolled: number;
  barsUpserted: number;
  failedTickers: string[];
}

export interface PollEodOptions {
  tickers?: readonly string[];
}

// 540 days ≈ 378 trading days — comfortable headroom over the 252 bars 1y
// returns need. Tiingo dedupes upserts by (ticker, date) so the daily cron
// incremental write stays cheap after the initial backfill.
const WINDOW_DAYS = 540;
const REFRESH_WINDOW_DAYS = 14;
const ARTICLE_WINDOW_DAYS = 30;
const COVERAGE_TOLERANCE_DAYS = 7;
const MIN_REQUIRED_BARS = 252;
const MAX_TIINGO_FALLBACKS = 100;

// Day-trade scanner universe. Mirrors the Step-1 universe selection in
// packages/core/src/goals/dayTradeScanner.ts (scanDayTradeCandidates): the
// TickerMetrics rows clearing the liquidity floor, capped, ordered by liquidity
// desc. Without these in the poll scope a scanner candidate that isn't in the
// news window freezes its DailyBar and never refreshes. Values are duplicated
// (not imported) because they're module-private there; keep them in sync.
const SCANNER_MIN_DOLLAR_VOLUME = 5_000_000;
const SCANNER_UNIVERSE_CAP = 400;

// Inline pacing on top of provider behavior. Tiingo also has its own 16/min
// limiter; Yahoo is unofficial, so keep Canadian requests gently spaced.
const TIINGO_THROTTLE_MS = 250;
const YFINANCE_THROTTLE_MS = 250;
// Retry delays for empty/429 responses. Adapter swallows 429 into an empty
// array, so we treat 0-bar results as transient until the 4th attempt.
const RETRY_DELAYS_MS = [1000, 3000, 8000];
const DAY_MS = 24 * 60 * 60 * 1000;
const BENCHMARK_TICKERS = ['SPY'] as const;
const BENCHMARK_TICKER_SET: ReadonlySet<string> = new Set(BENCHMARK_TICKERS);

// Belt-and-braces stopword pass — common English words the ticker extractor
// sometimes lets through. Mirrors the noise set in computeDiscovery.
const TICKER_NOISE = new Set([
  'THE',
  'BIG',
  'BET',
  'ASIA',
  'HITS',
  'RISE',
  'WALL',
  'ORAL',
  'ABLE',
  'PEAK',
  'ISN',
  'WHO',
  'NEW',
  'NOW',
  'END',
  'TOP',
  'BANK',
  'CASH',
  'CALL',
  'PUT',
  'DEAL',
  'GAIN',
  'LOSS',
  'HIGH',
  'LOW',
  'LIVE',
  'BUY',
  'SELL',
  'HOLD',
  'LONG',
  'SHORT',
]);

async function collectTargetTickers(): Promise<string[]> {
  const sinceArticles = new Date(Date.now() - ARTICLE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const [held, watch, scannerRows, articleTickerRows] = await Promise.all([
    prisma.position.findMany({
      where: { closedAt: null },
      select: { ticker: true },
    }),
    prisma.watchlist.findMany({ select: { ticker: true } }),
    // Day-trade scanner universe — see SCANNER_* constants. Same selection the
    // scanner uses to build its candidate pool, so the names it can surface are
    // exactly the names that get fresh bars.
    prisma.tickerMetrics.findMany({
      where: { avgDollarVolume30d: { gte: SCANNER_MIN_DOLLAR_VOLUME } },
      select: { ticker: true },
      orderBy: { avgDollarVolume30d: 'desc' },
      take: SCANNER_UNIVERSE_CAP,
    }),
    prisma.$queryRaw<Array<{ ticker: string }>>`
      SELECT DISTINCT t AS ticker
      FROM "Article", unnest(tickers) AS t
      WHERE "publishedAt" > ${sinceArticles}
        AND t != '__PENDING__'
        AND t != ''
    `,
  ]);

  // Priority order: holdings first (the only tickers /compare actually
  // displays), then watchlist, then the scanner universe (so scanner candidates
  // refresh before the lower-value article tail), then article-mentioned.
  // Rate-limit pressure hits the tail, not the head — held positions always get
  // served.
  const heldList: string[] = [];
  const heldSet = new Set<string>();
  for (const r of held) {
    const t = r.ticker.toUpperCase();
    if (heldSet.has(t)) continue;
    heldSet.add(t);
    heldList.push(t);
  }

  const watchList: string[] = [];
  const watchSet = new Set<string>();
  for (const r of watch) {
    const t = r.ticker.toUpperCase();
    if (watchSet.has(t)) continue;
    watchSet.add(t);
    watchList.push(t);
  }

  // Scanner universe is already ordered by liquidity desc (highest-value names
  // first), so a take(SCANNER_UNIVERSE_CAP) trim under rate pressure drops the
  // lowest-liquidity tail — matching the scanner's own truncation behavior.
  const scannerList: string[] = [];
  const scannerSet = new Set<string>();
  for (const r of scannerRows) {
    const t = r.ticker.toUpperCase();
    if (heldSet.has(t) || watchSet.has(t) || scannerSet.has(t)) continue;
    scannerSet.add(t);
    scannerList.push(t);
  }

  const articleList: string[] = [];
  const articleSet = new Set<string>();
  for (const r of articleTickerRows) {
    const t = r.ticker.toUpperCase();
    if (TICKER_NOISE.has(t)) continue;
    if (articleSet.has(t)) continue;
    articleSet.add(t);
    articleList.push(t);
  }

  return [
    ...BENCHMARK_TICKERS,
    ...heldList.filter((t) => !BENCHMARK_TICKER_SET.has(t)),
    ...watchList.filter((t) => !heldSet.has(t) && !BENCHMARK_TICKER_SET.has(t)),
    ...scannerList.filter((t) => !BENCHMARK_TICKER_SET.has(t)),
    ...articleList.filter(
      (t) =>
        !heldSet.has(t) && !watchSet.has(t) && !scannerSet.has(t) && !BENCHMARK_TICKER_SET.has(t),
    ),
  ];
}

function normalizeTargetTickers(tickers: readonly string[]): string[] {
  return Array.from(
    new Set(
      tickers
        .map((ticker) => ticker.trim().toUpperCase())
        .filter((ticker) => /^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(ticker)),
    ),
  );
}

async function pollTickerWithRetry(
  tiingo: ReturnType<typeof getTiingo>,
  ticker: string,
  start: Date,
  end: Date,
): Promise<NormalizedBar[]> {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    const bars = await tiingo.getDailyPrices(ticker, start, end);
    if (bars.length > 0) return bars;
    if (attempt < RETRY_DELAYS_MS.length) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
    }
  }
  return [];
}

async function loadCoverage(tickers: readonly string[]): Promise<Map<string, BarCoverage>> {
  if (tickers.length === 0) return new Map();
  const rows = await prisma.dailyBar.groupBy({
    by: ['ticker'],
    where: { ticker: { in: [...tickers] } },
    _min: { date: true },
    _count: { _all: true },
  });
  return new Map(
    rows.map((row) => [
      row.ticker.toUpperCase(),
      { oldest: row._min.date, count: row._count._all },
    ]),
  );
}

async function loadUsBars(
  tickers: readonly string[],
  fullHistory: ReadonlySet<string>,
  fullStart: Date,
  refreshStart: Date,
  end: Date,
  log: FastifyBaseLogger | Console,
): Promise<Map<string, NormalizedBar[]>> {
  const out = new Map<string, NormalizedBar[]>();
  const windows = [
    { tickers: tickers.filter((ticker) => fullHistory.has(ticker)), start: fullStart },
    { tickers: tickers.filter((ticker) => !fullHistory.has(ticker)), start: refreshStart },
  ];
  for (const window of windows) {
    if (window.tickers.length === 0) continue;
    try {
      const rows = await getAlpaca().getMultiBars(window.tickers, '1Day', window.start, end);
      for (const [ticker, bars] of rows) out.set(ticker.toUpperCase(), bars);
    } catch (err) {
      log.warn?.(
        {
          tickerCount: window.tickers.length,
          err: err instanceof Error ? err.message : err,
        },
        'pollEodHistory: Alpaca batch failed; trying bounded Tiingo fallback',
      );
    }
  }
  return out;
}

async function persistBars(bars: readonly NormalizedBar[]): Promise<number> {
  const { written } = await upsertBars(
    bars.map((bar) => ({
      ticker: bar.ticker,
      date: bar.timestamp,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
      source: bar.source,
    })),
  );
  return written;
}

export async function pollEodHistory(
  log: FastifyBaseLogger | Console = console,
  options: PollEodOptions = {},
): Promise<PollEodResult> {
  const requestedTickers = normalizeTargetTickers(options.tickers ?? []);
  const tickers = requestedTickers.length > 0 ? requestedTickers : await collectTargetTickers();

  const end = new Date();
  const start = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const refreshStart = new Date(Date.now() - REFRESH_WINDOW_DAYS * DAY_MS);

  let barsUpserted = 0;
  const failed = new Set<string>();
  let tiingoFallbacks = 0;
  let tiingo: ReturnType<typeof getTiingo> | null | undefined;

  const oldestNeeded = new Date(Date.now() - WINDOW_DAYS * DAY_MS);
  const coverage = await loadCoverage(tickers);
  const fullHistory = new Set(
    tickers.filter((ticker) =>
      requiresFullHistory(
        coverage.get(ticker),
        oldestNeeded,
        COVERAGE_TOLERANCE_DAYS,
        MIN_REQUIRED_BARS,
      ),
    ),
  );
  const canadian = new Set(tickers.filter((ticker) => /\.(TO|NE|V)$/i.test(ticker)));
  const usTickers = tickers.filter((ticker) => !canadian.has(ticker));
  const usBars = await loadUsBars(usTickers, fullHistory, start, refreshStart, end, log);

  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i]!;
    try {
      const tickerStart = fullHistory.has(ticker) ? start : refreshStart;
      let bars: NormalizedBar[] = [];
      if (canadian.has(ticker)) {
        bars = await getYFinance().getDailyBars(ticker, tickerStart, end);
        if (i < tickers.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, YFINANCE_THROTTLE_MS));
        }
      } else {
        bars = usBars.get(ticker) ?? [];
        if (bars.length === 0 && tiingoFallbacks < MAX_TIINGO_FALLBACKS) {
          tiingoFallbacks++;
          if (tiingo === undefined) {
            try {
              tiingo = getTiingo();
            } catch (err) {
              tiingo = null;
              log.warn?.(
                { err: err instanceof Error ? err.message : err },
                'pollEodHistory: Tiingo fallback unavailable',
              );
            }
          }
          if (tiingo) {
            bars = await pollTickerWithRetry(tiingo, ticker, tickerStart, end);
            if (i < tickers.length - 1) {
              await new Promise((resolve) => setTimeout(resolve, TIINGO_THROTTLE_MS));
            }
          }
        }
      }
      if (bars.length === 0) {
        log.warn?.({ ticker }, 'pollEodHistory: no provider returned bars');
        failed.add(ticker);
        continue;
      }
      const written = await persistBars(bars);
      barsUpserted += written;
      log.info?.(
        { ticker, fetched: bars.length, written, source: bars[0]?.source },
        'pollEodHistory: bars persisted',
      );
    } catch (err) {
      log.warn?.(
        { ticker, err: err instanceof Error ? err.message : err },
        'pollEodHistory: ticker failed',
      );
      failed.add(ticker);
    }
  }

  const result = {
    tickersPolled: tickers.length,
    barsUpserted,
    failedTickers: [...failed],
  };
  log.info?.(
    {
      ...result,
      fullHistoryTickers: fullHistory.size,
      alpacaTickersReturned: usBars.size,
      tiingoFallbacks,
    },
    'pollEodHistory: complete',
  );
  return result;
}
