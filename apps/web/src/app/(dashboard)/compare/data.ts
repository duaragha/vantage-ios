/**
 * /compare — server-side data loader.
 *
 * Pulls the latest DiscoveryScore batch, annotates held vs unheld rows, and
 * computes a "best swap" list directly (not via scoreRotations) so pairs
 * emit even when the held thesis is Intact. This gives the user a constant
 * market-vs-holdings verdict regardless of whether the automatic rotation
 * trigger is firing.
 *
 * The "why" explanation is deterministic — we stringify the biggest signal
 * deltas between the held ticker's breakdown and the candidate's. No LLM.
 */

import {
  EventKind,
  prisma,
  getSettings,
  getLatestBarsForTickers,
  type AnalystRecommendation,
  type DailyBar,
  type DiscoveryScore,
  type MarketEvent,
  type Position,
  type TickerMetrics,
  type Thesis,
  type ThesisStatus,
  type Watchlist,
  type TickerUniverse,
} from '@vantage/db';
import {
  DEFAULT_WEIGHTS,
  coerceWeights,
  discoveryScoreDeltaForRotation,
  type DiscoveryWeights,
  type SignalBreakdown,
} from '@vantage/core/discover/signals';
import { consensusFromRow, type Consensus } from '@vantage/core/discover/analyst-upgrades';
import { CURATED_POOL, incomeRiskFloorForSecurity } from '@vantage/core/goals';
import {
  MONTHLY_INCOME_TICKERS,
  monthlyIncomeFallback,
  type IncomeRiskKey,
} from '@vantage/core/goals/monthly-income';
import { computeVerdict, type Verdict } from '@vantage/core/verdict';
import { convertToUsdWithRate, getUsdCadRate } from '@vantage/core/fx';
import { componentLogger } from '@vantage/notify';
import { exchangeFromSymbol, resolveListingCurrency } from '@vantage/sources';
import {
  collapseDailyScoreTrend,
  computeWindowStats,
  explainSwapSignals,
  normalizeSignalBreakdown,
  selectPriceSource,
  subtractBenchmarkReturn,
  type SelectedPrice,
  type WindowStats,
} from '@/lib/compareResearch';
import { resolveIncomeYieldEstimate } from '@/lib/discoveryLens';

type PriceWithFallback = SelectedPrice;
const log = componentLogger('web/compare/data');

/**
 * Return the best available price per ticker — LivePrice when fresh
 * (within 10 minutes), else the latest DailyBar close. Tickers with neither
 * source are omitted. This matches the persisted-price rule used by portfolio.
 */
async function getLivePricesWithFallback(
  tickers: readonly string[],
): Promise<Map<string, PriceWithFallback>> {
  const out = new Map<string, PriceWithFallback>();
  if (tickers.length === 0) return out;
  const upper = Array.from(new Set(tickers.map((t) => t.toUpperCase())));

  const [livePrices, bars] = await Promise.all([
    prisma.livePrice.findMany({ where: { ticker: { in: upper } } }),
    getLatestBarsForTickers(upper) as Promise<Map<string, DailyBar>>,
  ]);

  const liveByTicker = new Map(livePrices.map((l) => [l.ticker.toUpperCase(), l]));

  const now = Date.now();
  for (const t of upper) {
    const live = liveByTicker.get(t);
    const bar = bars.get(t);
    const selected = selectPriceSource(
      now,
      live ? { price: Number(live.price), fetchedAt: live.fetchedAt } : null,
      bar ? { close: Number(bar.close), date: bar.date } : null,
    );
    if (selected) out.set(t, selected);
  }
  return out;
}

export interface CompareFundamentals {
  peTtm: number | null;
  evToEbitda: number | null;
  roeTtm: number | null;
  grossMarginTtm: number | null;
  operatingMarginTtm: number | null;
  netMarginTtm: number | null;
  debtToEquity: number | null;
  dividendYieldTtm: number | null;
  dividendPayoutRatio: number | null;
  revenueGrowthYoy: number | null;
  epsGrowthYoy: number | null;
  beta: number | null;
}

export interface CompareAnalystConsensus {
  consensus: Consensus;
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
  period: string;
}

export interface CompareRow {
  ticker: string;
  name: string | null;
  sector: string | null;
  /** Phase 16 — exchange code for badge rendering. */
  exchange: string;
  currency: 'USD' | 'CAD';
  category: string | null;
  score: number;
  breakdown: SignalBreakdown | null;
  curatedIncome: boolean;
  incomeCadence: 'monthly' | null;
  incomeRiskFloor: IncomeRiskKey;
  incomeYieldEstimate: number | null;
  incomeYieldSource: 'metrics' | 'curated' | null;
  metrics: CompareFundamentals | null;
  analyst: CompareAnalystConsensus | null;
  catalyst: { kind: string; occurredAt: string } | null;
  held: boolean;
  watchlisted: boolean;
  thesisStatus: ThesisStatus | null;
  sharesHeld: number | null;
  avgCost: number | null;
  valueUsd: number | null;
  thirtyDayReturnPct: number | null;
  r6moPct: number | null;
  r1yPct: number | null;
  alpha30Pct: number | null;
  alpha6moPct: number | null;
  alpha1yPct: number | null;
  high52: number | null;
  low52: number | null;
  fromHighPct: number | null;
  scoreTrend: number[];
  computedAt: string;
  stale: boolean;
  /** Plain-english action verdict — see packages/core/src/discover/verdict.ts. */
  verdict: Verdict;
  /** True when the per-ticker price came from a fresh LivePrice row
   * (within 10 min); false when it came from DailyBar or was unavailable. */
  priceIsLive: boolean;
  latestPrice: number | null;
  /** Age of the price source in seconds. 0 when no price was found. */
  priceAgeSeconds: number;
}

export interface SwapPair {
  trimTicker: string;
  trimName: string | null;
  trimScore: number;
  trimThesisStatus: ThesisStatus | null;
  trimBreakdown: SignalBreakdown | null;
  trimSharesHeld: number | null;
  trimValueUsd: number | null;
  trimThirtyDayReturnPct: number | null;
  trimVerdict: Verdict;

  buyTicker: string;
  buyName: string | null;
  buyScore: number;
  buyBreakdown: SignalBreakdown | null;
  buyThirtyDayReturnPct: number | null;
  buyVerdict: Verdict;

  scoreDelta: number;
  wouldTrigger: boolean;
  triggerThreshold: number;
  why: string;
}

export interface CompareData {
  rows: CompareRow[];
  swaps: SwapPair[];
  signalWeights: DiscoveryWeights;
  computedAt: string | null;
  heldCount: number;
  unheldCount: number;
}

const DEFAULT_SWAP_THRESHOLD = 0.3;
const ACTIVE_ROTATION_THRESHOLD = 0.6;
const STALE_MS = 24 * 60 * 60 * 1000;
const CURATED_BY_TICKER = new Map(
  CURATED_POOL.map((security) => [security.ticker.toUpperCase(), security]),
);

/**
 * Load the unified compare view.
 *
 * Strategy: read the latest DiscoveryScore batch (which includes BOTH held
 * and unheld tickers after computeDiscovery + scoreHoldings run). Then:
 *   1. Build row-per-ticker with name/sector/held-flag/thesis annotation.
 *   2. Rank by discoveryScore desc.
 *   3. For each held ticker, find the best candidate (delta ≥ 0.3).
 */
export async function loadCompareData(): Promise<CompareData> {
  // Latest compute batch.
  const latest = await prisma.discoveryScore.aggregate({
    _max: { computedAt: true },
  });
  const computedAt = latest._max.computedAt ?? null;

  if (!computedAt) {
    const positions = await prisma.position.findMany({
      where: { closedAt: null },
      select: { id: true },
    });
    return {
      rows: [],
      swaps: [],
      signalWeights: DEFAULT_WEIGHTS,
      computedAt: null,
      heldCount: positions.length,
      unheldCount: 0,
    };
  }

  // All rows from the latest batch — includes held + unheld since
  // scoreHoldings writes into the same table.
  const scores = (await prisma.discoveryScore.findMany({
    where: { computedAt },
    orderBy: { score: 'desc' },
  })) as DiscoveryScore[];

  const tickers = scores.map((s) => s.ticker.toUpperCase());

  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60_000);
  const [
    universe,
    positions,
    watchlist,
    settings,
    metricsRows,
    analystRows,
    catalystEvents,
    scoreHistory,
  ] = await Promise.all([
    prisma.tickerUniverse.findMany({
      where: { symbol: { in: tickers } },
      select: {
        symbol: true,
        name: true,
        sector: true,
        exchange: true,
        currency: true,
        category: true,
      },
    }) as Promise<
      Array<
        Pick<TickerUniverse, 'symbol' | 'name' | 'sector' | 'exchange' | 'currency' | 'category'>
      >
    >,
    prisma.position.findMany({
      where: { closedAt: null },
      include: { thesis: true },
    }) as Promise<Array<Position & { thesis: Thesis | null }>>,
    prisma.watchlist.findMany({
      select: { ticker: true },
    }) as Promise<Array<Pick<Watchlist, 'ticker'>>>,
    getSettings(),
    prisma.tickerMetrics.findMany({
      where: { ticker: { in: tickers } },
      select: {
        ticker: true,
        peTtm: true,
        evToEbitda: true,
        roeTtm: true,
        grossMarginTtm: true,
        operatingMarginTtm: true,
        netMarginTtm: true,
        debtToEquity: true,
        dividendYieldTtm: true,
        dividendPayoutRatio: true,
        revenueGrowthYoy: true,
        epsGrowthYoy: true,
        beta: true,
      },
    }) as Promise<
      Array<
        Pick<
          TickerMetrics,
          | 'ticker'
          | 'peTtm'
          | 'evToEbitda'
          | 'roeTtm'
          | 'grossMarginTtm'
          | 'operatingMarginTtm'
          | 'netMarginTtm'
          | 'debtToEquity'
          | 'dividendYieldTtm'
          | 'dividendPayoutRatio'
          | 'revenueGrowthYoy'
          | 'epsGrowthYoy'
          | 'beta'
        >
      >
    >,
    prisma.analystRecommendation.findMany({
      where: { ticker: { in: tickers } },
      orderBy: { period: 'desc' },
    }) as Promise<AnalystRecommendation[]>,
    prisma.marketEvent.findMany({
      where: {
        ticker: { in: tickers },
        kind: {
          in: [
            EventKind.InsiderCluster,
            EventKind.EarningsBeat,
            EventKind.Material8K,
            EventKind.AnalystUpgrade,
          ],
        },
        occurredAt: { gte: since30d },
      },
      orderBy: { occurredAt: 'desc' },
      select: { ticker: true, kind: true, occurredAt: true },
    }) as Promise<Array<Pick<MarketEvent, 'ticker' | 'kind' | 'occurredAt'>>>,
    prisma.discoveryScore.findMany({
      where: { ticker: { in: tickers }, computedAt: { gte: since30d } },
      orderBy: { computedAt: 'asc' },
      select: { ticker: true, score: true, computedAt: true },
    }),
  ]);

  const signalWeights: DiscoveryWeights = {
    ...DEFAULT_WEIGHTS,
    ...coerceWeights(settings?.discoveryWeights),
  };

  const singlePositionCapPct =
    settings && typeof settings.singlePositionCapPct === 'number'
      ? settings.singlePositionCapPct
      : null;

  const universeMap = new Map<
    string,
    {
      name: string | null;
      sector: string | null;
      exchange: string;
      currency: 'USD' | 'CAD';
      category: string | null;
    }
  >();
  for (const u of universe) {
    universeMap.set(u.symbol.toUpperCase(), {
      name: u.name,
      sector: u.sector,
      exchange: u.exchange,
      currency: u.currency === 'CAD' ? 'CAD' : 'USD',
      category: u.category ?? null,
    });
  }

  const metricsByTicker = new Map<string, CompareFundamentals>();
  for (const row of metricsRows) {
    metricsByTicker.set(row.ticker.toUpperCase(), {
      peTtm: row.peTtm ?? null,
      evToEbitda: row.evToEbitda ?? null,
      roeTtm: row.roeTtm ?? null,
      grossMarginTtm: row.grossMarginTtm ?? null,
      operatingMarginTtm: row.operatingMarginTtm ?? null,
      netMarginTtm: row.netMarginTtm ?? null,
      debtToEquity: row.debtToEquity ?? null,
      dividendYieldTtm: row.dividendYieldTtm ?? null,
      dividendPayoutRatio: row.dividendPayoutRatio ?? null,
      revenueGrowthYoy: row.revenueGrowthYoy ?? null,
      epsGrowthYoy: row.epsGrowthYoy ?? null,
      beta: row.beta ?? null,
    });
  }

  const analystByTicker = new Map<string, CompareAnalystConsensus>();
  for (const row of analystRows) {
    const ticker = row.ticker.toUpperCase();
    if (analystByTicker.has(ticker)) continue;
    analystByTicker.set(ticker, {
      consensus: consensusFromRow(row),
      strongBuy: row.strongBuy,
      buy: row.buy,
      hold: row.hold,
      sell: row.sell,
      strongSell: row.strongSell,
      period: row.period.toISOString(),
    });
  }

  const catalystByTicker = new Map<string, { kind: string; occurredAt: string }>();
  for (const event of catalystEvents) {
    if (!event.ticker) continue;
    const ticker = event.ticker.toUpperCase();
    if (catalystByTicker.has(ticker)) continue;
    catalystByTicker.set(ticker, {
      kind: String(event.kind),
      occurredAt: event.occurredAt.toISOString(),
    });
  }

  const scorePointsByTicker = new Map<string, Array<{ score: number; computedAt: Date }>>();
  for (const point of scoreHistory) {
    const ticker = point.ticker.toUpperCase();
    const points = scorePointsByTicker.get(ticker) ?? [];
    points.push({ score: point.score, computedAt: point.computedAt });
    scorePointsByTicker.set(ticker, points);
  }

  const positionsByTicker = new Map<string, Array<Position & { thesis: Thesis | null }>>();
  for (const p of positions) {
    const ticker = p.ticker.toUpperCase();
    const lots = positionsByTicker.get(ticker) ?? [];
    lots.push(p);
    positionsByTicker.set(ticker, lots);
  }
  const watchSet = new Set(watchlist.map((w) => w.ticker.toUpperCase()));

  // Multi-window returns (30d / 6mo / 1y) from DailyBar in one batched query.
  // The 30d value also feeds the verdict engine (replaces the old 20d input).
  const returnsByTicker = await loadMultiWindowReturns([...tickers, 'SPY']);
  const benchmarkReturns = returnsByTicker.get('SPY') ?? null;

  // Live-ish prices via LivePrice (within 10 min) → DailyBar fallback →
  // finally avgCost. The helper returns metadata so the UI can render
  // "Live 12s ago" vs "Last close".
  const priceByTicker = await getLivePricesWithFallback(tickers);

  // Per-position native currency: the stored Position.currency wins, else the
  // listing currency from TickerUniverse. Prices + avgCost are native, so each
  // value is converted to USD before summing/weighting.
  const usdCadRate = await getUsdCadRate();
  const currencyForPosition = (p: Position): 'USD' | 'CAD' => {
    const stored = (p as Position & { currency?: string | null }).currency;
    const meta = universeMap.get(p.ticker.toUpperCase());
    return resolveListingCurrency(p.ticker, stored ?? meta?.currency, meta?.exchange);
  };

  // Pre-pass: total portfolio value across held tickers, in USD. Falls back to
  // shares × avgCost when neither a live nor close price is available so
  // position-weight math stays stable during full price-oracle outages.
  let totalPortfolioValueUsd = 0;
  for (const p of positions) {
    const t = p.ticker.toUpperCase();
    const shares = Number(p.shares);
    const entry = priceByTicker.get(t);
    const price = entry?.price ?? Number(p.avgCost);
    if (Number.isFinite(shares) && Number.isFinite(price) && shares > 0 && price > 0) {
      const native = shares * price;
      totalPortfolioValueUsd += convertToUsdWithRate(native, currencyForPosition(p), usdCadRate);
    }
  }

  const rows: CompareRow[] = scores.map((s) => {
    const ticker = s.ticker.toUpperCase();
    const meta = universeMap.get(ticker);
    const breakdown = normalizeSignalBreakdown(s.signalBreakdown);
    const metrics = metricsByTicker.get(ticker) ?? null;
    const curated = CURATED_BY_TICKER.get(ticker) ?? null;
    const suffixExchange = exchangeFromSymbol(ticker);
    const listingExchange = suffixExchange !== 'US' ? suffixExchange : (meta?.exchange ?? 'US');
    const listingCurrency = resolveListingCurrency(ticker, meta?.currency, meta?.exchange);
    const tickerPositions = positionsByTicker.get(ticker) ?? [];
    const position = tickerPositions[0] ?? null;
    const held = tickerPositions.length > 0;
    const thesisStatus = weakestThesisStatus(tickerPositions);
    const shares = held ? tickerPositions.reduce((sum, lot) => sum + Number(lot.shares), 0) : null;
    const avgCost = held ? weightedAverageCost(tickerPositions) : null;
    const priceEntry = priceByTicker.get(ticker) ?? null;
    const livePrice = priceEntry ? priceEntry.price : null;
    const positionCurrency = position ? currencyForPosition(position) : listingCurrency;
    const valueBasisPrice = livePrice ?? avgCost;
    const valueUsd =
      shares !== null && valueBasisPrice !== null
        ? convertToUsdWithRate(shares * valueBasisPrice, positionCurrency, usdCadRate)
        : null;
    const stale = Date.now() - s.computedAt.getTime() > STALE_MS;
    const windows = returnsByTicker.get(ticker);
    const thirtyDayReturnPct = windows?.r30 ?? null;
    const r6moPct = windows?.r6mo ?? null;
    const r1yPct = windows?.r1y ?? null;
    const alpha30Pct = subtractBenchmarkReturn(thirtyDayReturnPct, benchmarkReturns?.r30 ?? null);
    const alpha6moPct = subtractBenchmarkReturn(r6moPct, benchmarkReturns?.r6mo ?? null);
    const alpha1yPct = subtractBenchmarkReturn(r1yPct, benchmarkReturns?.r1y ?? null);

    // Position weight: use live-priced value when available, otherwise
    // avg-cost basis (same fallback rule as totalPortfolioValueUsd) so the
    // verdict math remains well-defined during transient price gaps.
    let positionWeightPct: number | null = null;
    if (held && totalPortfolioValueUsd > 0) {
      const basisPrice = livePrice ?? avgCost ?? 0;
      const basisNative = shares !== null && basisPrice > 0 ? shares * basisPrice : 0;
      const basisValue = convertToUsdWithRate(basisNative, positionCurrency, usdCadRate);
      if (basisValue > 0) {
        positionWeightPct = (basisValue / totalPortfolioValueUsd) * 100;
      }
    }

    const verdict = held
      ? computeVerdict({
          held: true,
          score: s.score,
          thesisStatus,
          recentReturnPct: thirtyDayReturnPct,
          positionWeightPct,
          singlePositionCapPct,
        })
      : computeVerdict({
          held: false,
          score: s.score,
          breakdown,
        });

    const incomeFallback = monthlyIncomeFallback(ticker);
    const fallbackYield = curated?.expectedYield ?? incomeFallback?.expectedYield ?? null;
    const incomeYield = resolveIncomeYieldEstimate(metrics?.dividendYieldTtm, fallbackYield);

    return {
      ticker,
      name: meta?.name ?? null,
      sector: meta?.sector ?? null,
      exchange: listingExchange,
      currency: listingCurrency,
      category: meta?.category ?? curated?.category ?? null,
      score: s.score,
      breakdown,
      curatedIncome: curated !== null && (curated.expectedYield ?? 0) > 0,
      incomeCadence: MONTHLY_INCOME_TICKERS.has(ticker) ? 'monthly' : null,
      incomeRiskFloor: curated
        ? incomeRiskFloorForSecurity(curated)
        : (incomeFallback?.riskFloor ?? 'aggressive'),
      incomeYieldEstimate: incomeYield.estimate,
      incomeYieldSource: incomeYield.source,
      metrics,
      analyst: analystByTicker.get(ticker) ?? null,
      catalyst: catalystByTicker.get(ticker) ?? null,
      held,
      watchlisted: watchSet.has(ticker),
      thesisStatus,
      sharesHeld: shares,
      avgCost,
      valueUsd,
      thirtyDayReturnPct,
      r6moPct,
      r1yPct,
      alpha30Pct,
      alpha6moPct,
      alpha1yPct,
      high52: windows?.high52 ?? null,
      low52: windows?.low52 ?? null,
      fromHighPct: windows?.fromHighPct ?? null,
      scoreTrend: collapseDailyScoreTrend(scorePointsByTicker.get(ticker) ?? []),
      computedAt: s.computedAt.toISOString(),
      stale,
      verdict,
      priceIsLive: priceEntry?.isLive ?? false,
      latestPrice: priceEntry?.price ?? null,
      priceAgeSeconds: priceEntry?.ageSeconds ?? 0,
    };
  });

  // Build swap pairs: for each held ticker, pick the top candidate where
  // Delta is the raw 0-10 score gap normalized to the 0-1 rotation scale.
  // Status-gated guidance (wouldTrigger) is reported but not used as a filter.
  const heldRows = rows.filter((r) => r.held);
  const unheldRows = rows.filter((r) => !r.held);
  const swaps: SwapPair[] = [];
  const seenHeld = new Set<string>();
  // Walk held in descending "weakness" (lowest score first) — the most
  // rotation-worthy candidate appears first in the panel.
  const heldWorstFirst = [...heldRows].sort((a, b) => a.score - b.score);
  for (const held of heldWorstFirst) {
    if (seenHeld.has(held.ticker)) continue;
    let bestCand: CompareRow | null = null;
    let bestDelta = 0;
    for (const cand of unheldRows) {
      const delta = discoveryScoreDeltaForRotation(cand.score, held.score);
      if (delta < DEFAULT_SWAP_THRESHOLD) continue;
      if (delta > bestDelta) {
        bestDelta = delta;
        bestCand = cand;
      }
    }
    if (!bestCand) continue;
    seenHeld.add(held.ticker);
    const wouldTrigger =
      bestDelta >= ACTIVE_ROTATION_THRESHOLD &&
      (held.thesisStatus === 'Weakening' || held.thesisStatus === 'Broken');
    swaps.push({
      trimTicker: held.ticker,
      trimName: held.name,
      trimScore: held.score,
      trimThesisStatus: held.thesisStatus,
      trimBreakdown: held.breakdown,
      trimSharesHeld: held.sharesHeld,
      trimValueUsd: held.valueUsd,
      trimThirtyDayReturnPct: held.thirtyDayReturnPct,
      trimVerdict: held.verdict,

      buyTicker: bestCand.ticker,
      buyName: bestCand.name,
      buyScore: bestCand.score,
      buyBreakdown: bestCand.breakdown,
      buyThirtyDayReturnPct: bestCand.thirtyDayReturnPct,
      buyVerdict: bestCand.verdict,

      scoreDelta: Number(bestDelta.toFixed(3)),
      wouldTrigger,
      triggerThreshold: ACTIVE_ROTATION_THRESHOLD,
      why: explainSwapSignals(held, bestCand, signalWeights),
    });
  }
  // Keep the top 5 most-skewed pairs.
  swaps.sort((a, b) => b.scoreDelta - a.scoreDelta);
  const topSwaps = swaps.slice(0, 5);

  return {
    rows,
    swaps: topSwaps,
    signalWeights,
    computedAt: computedAt.toISOString(),
    heldCount: heldRows.length,
    unheldCount: unheldRows.length,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function weakestThesisStatus(
  positions: ReadonlyArray<Position & { thesis: Thesis | null }>,
): ThesisStatus | null {
  const rank: Record<ThesisStatus, number> = {
    Broken: 0,
    Weakening: 1,
    Intact: 2,
    Strengthening: 3,
  };
  let weakest: ThesisStatus | null = null;
  for (const position of positions) {
    const status = position.thesis?.status ?? null;
    if (status && (weakest === null || rank[status] < rank[weakest])) weakest = status;
  }
  return weakest;
}

function weightedAverageCost(positions: ReadonlyArray<Position>): number | null {
  let shares = 0;
  let cost = 0;
  for (const position of positions) {
    const lotShares = Number(position.shares);
    const lotCost = Number(position.avgCost);
    if (!Number.isFinite(lotShares) || !Number.isFinite(lotCost) || lotShares <= 0) continue;
    shares += lotShares;
    cost += lotShares * lotCost;
  }
  return shares > 0 ? cost / shares : null;
}

/**
 * Multi-window trading-day returns per ticker (30d ≈ 22 bars, 6mo ≈ 126,
 * 1y ≈ 252), plus the 52-week range, sourced from DailyBar. SPY travels
 * through this same batch so the caller can calculate apples-to-apples alpha.
 *
 * Any window whose index would fall past the available bar count yields null
 * — we don't extrapolate or back-fill, so /compare renders `—` until
 * pollEodHistory has accumulated enough history.
 */
async function loadMultiWindowReturns(
  tickers: readonly string[],
): Promise<Map<string, WindowStats>> {
  const out = new Map<string, WindowStats>();
  if (tickers.length === 0) return out;
  const upper = Array.from(new Set(tickers.map((t) => t.toUpperCase())));

  try {
    const since = new Date(Date.now() - 420 * 24 * 60 * 60_000);
    const rows = (await prisma.dailyBar.findMany({
      where: { ticker: { in: upper }, date: { gte: since } },
      orderBy: [{ ticker: 'asc' }, { date: 'desc' }],
      select: { ticker: true, close: true, high: true, low: true },
    })) as Array<Pick<DailyBar, 'ticker' | 'close' | 'high' | 'low'>>;

    const byTicker = new Map<string, Array<Pick<DailyBar, 'ticker' | 'close' | 'high' | 'low'>>>();
    for (const r of rows) {
      const t = r.ticker.toUpperCase();
      const list = byTicker.get(t);
      if (list) list.push(r);
      else byTicker.set(t, [r]);
    }

    for (const [t, bars] of byTicker) {
      const stats = computeWindowStats(
        bars.map((bar) => ({
          close: Number(bar.close),
          high: Number(bar.high),
          low: Number(bar.low),
        })),
      );
      if (stats) out.set(t, stats);
    }
  } catch (error) {
    log.warn({ err: error, tickerCount: upper.length }, 'compare historical returns unavailable');
  }
  return out;
}

// Note: the previous `loadLatestPrices` helper was replaced by
// `getLivePricesWithFallback` above, which prefers a fresh LivePrice row
// (written every minute during market hours by pollPrices) over the latest
// DailyBar close — giving /compare intraday valuations during the session.
