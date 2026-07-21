/**
 * Quality gates — Phase 17.6.
 *
 * Shared pre-flight check used by the catalyst engine (sub-phase B) and
 * any future discovery surface that wants the same "is this ticker
 * actually retail-investable?" filter. Each catalyst-driven buy
 * suggestion runs through `qualityFilter(ticker)` before Sonnet is even
 * invoked — the rejected reason is captured as `actionJson.rejectedQualityReason`
 * on the corresponding Insight (when one is written) for transparency.
 *
 * Gates (all must pass):
 *   - Market cap ≥ UserSettings.discoveryMinMcapUsd ($500M default)
 *   - Avg daily dollar volume ≥ $5M, computed from the last 20 DailyBar
 *     rows × close price
 *   - Not flagged as a meme/lottery name (TickerUniverse.isLottery)
 *   - Has tier-1 news coverage in the last 30d (no silent stocks)
 *   - Active listing — TickerUniverse.lastRefreshed within 30d
 *
 * Returns `{ passes: true }` on a clean pass, or `{ passes: false, reason }`
 * with a short tag like 'no-universe-row' / 'low-mcap' / 'low-volume' /
 * 'lottery' / 'no-tier1-news' / 'stale-listing'.
 *
 * Pure with respect to its DB inputs — accepts a deps object so unit
 * tests can stub each fetch independently. The default factory uses the
 * real Prisma client.
 */

import { prisma, type TickerUniverse } from '@vantage/db';

export type QualityRejectReason =
  | 'no-universe-row'
  | 'low-mcap'
  | 'low-volume'
  | 'lottery'
  | 'no-tier1-news'
  | 'stale-listing';

export interface QualityFilterResult {
  passes: boolean;
  reason?: QualityRejectReason;
  /** Human-readable detail — useful in logs and Insight.actionJson. */
  detail?: string;
}

export interface QualityFilterDeps {
  /** Look up TickerUniverse row + isLottery flag. */
  loadUniverseRow(ticker: string): Promise<TickerUniverse | null>;
  /**
   * Sum of (close × volume) over the last 20 trading days, divided by 20.
   * Implementations should return null when fewer than 5 bars exist (we
   * can't trust the average). Pulled from packages/db/src/dailyBars.ts.
   */
  loadAvgDailyDollarVolume(
    ticker: string,
  ): Promise<{ avgDollarVolume: number; barCount: number } | null>;
  /**
   * Has at least one tier-1 article (sourceTier === 1) been published for
   * this ticker in the last 30 days?
   */
  hasTier1NewsLast30d(ticker: string): Promise<boolean>;
  /** UserSettings.discoveryMinMcapUsd. */
  loadMinMcapUsd(): Promise<number>;
}

export interface QualityFilterOptions {
  /** Minimum 20-day average dollar volume in USD. Default $5M. */
  minDailyDollarVolumeUsd?: number;
  /** Maximum staleness for TickerUniverse.lastRefreshed (days). Default 30. */
  maxStalenessDays?: number;
  /** Minimum bars needed before we'll trust the volume average. Default 5. */
  minBarsForVolume?: number;
}

const DEFAULT_MIN_DOLLAR_VOLUME = 5_000_000;
const DEFAULT_MAX_STALENESS_DAYS = 30;
const DEFAULT_MIN_BARS = 5;

/**
 * Default deps — wired up to the live Prisma client. Smoke + integration
 * tests can construct an alt deps object that returns fixtures.
 */
export function createDefaultQualityFilterDeps(): QualityFilterDeps {
  return {
    async loadUniverseRow(ticker) {
      return prisma.tickerUniverse.findUnique({
        where: { symbol: ticker.toUpperCase() },
      });
    },
    async loadAvgDailyDollarVolume(ticker) {
      const bars = await prisma.dailyBar.findMany({
        where: { ticker: ticker.toUpperCase() },
        orderBy: { date: 'desc' },
        take: 20,
      });
      if (bars.length === 0) return null;
      let sum = 0;
      let count = 0;
      for (const b of bars) {
        const close = Number(b.close.toString());
        const volume = Number(b.volume.toString());
        if (!Number.isFinite(close) || close <= 0) continue;
        if (!Number.isFinite(volume) || volume <= 0) continue;
        sum += close * volume;
        count++;
      }
      if (count === 0) return null;
      return { avgDollarVolume: sum / count, barCount: count };
    },
    async hasTier1NewsLast30d(ticker) {
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const row = await prisma.article.findFirst({
        where: {
          tickers: { has: ticker.toUpperCase() },
          sourceTier: 1,
          publishedAt: { gte: cutoff },
        },
        select: { id: true },
      });
      return row !== null;
    },
    async loadMinMcapUsd() {
      const settings = await prisma.userSettings.findUnique({
        where: { id: 1 },
        select: { discoveryMinMcapUsd: true },
      });
      if (!settings || settings.discoveryMinMcapUsd === null) {
        return 500_000_000;
      }
      return Number(settings.discoveryMinMcapUsd.toString());
    },
  };
}

/**
 * Run all five quality gates against `ticker`. Short-circuits on the
 * first failure — checks are ordered cheapest-first (DB row by unique
 * key) → most-expensive last (article scan by GIN index).
 */
export async function qualityFilter(
  ticker: string,
  opts: QualityFilterOptions = {},
  deps: QualityFilterDeps = createDefaultQualityFilterDeps(),
): Promise<QualityFilterResult> {
  const minDollarVolume =
    opts.minDailyDollarVolumeUsd ?? DEFAULT_MIN_DOLLAR_VOLUME;
  const maxStalenessDays =
    opts.maxStalenessDays ?? DEFAULT_MAX_STALENESS_DAYS;
  const minBars = opts.minBarsForVolume ?? DEFAULT_MIN_BARS;

  const universe = await deps.loadUniverseRow(ticker);
  if (!universe) {
    return {
      passes: false,
      reason: 'no-universe-row',
      detail: `${ticker.toUpperCase()} not present in TickerUniverse`,
    };
  }

  // Active listing — bail if the row is older than the staleness window.
  const ageMs = Date.now() - universe.lastRefreshed.getTime();
  if (ageMs > maxStalenessDays * 24 * 60 * 60 * 1000) {
    return {
      passes: false,
      reason: 'stale-listing',
      detail: `lastRefreshed > ${maxStalenessDays}d ago`,
    };
  }

  // Lottery flag.
  if (universe.isLottery) {
    return {
      passes: false,
      reason: 'lottery',
      detail: `TickerUniverse.isLottery=true`,
    };
  }

  // Market cap.
  const mcap =
    universe.marketCapUsd === null || universe.marketCapUsd === undefined
      ? null
      : Number(universe.marketCapUsd.toString());
  const minMcap = await deps.loadMinMcapUsd();
  if (mcap === null || !Number.isFinite(mcap) || mcap < minMcap) {
    return {
      passes: false,
      reason: 'low-mcap',
      detail:
        mcap === null
          ? `marketCapUsd unknown`
          : `marketCapUsd ${mcap.toFixed(0)} < ${minMcap.toFixed(0)}`,
    };
  }

  // Daily dollar volume.
  const vol = await deps.loadAvgDailyDollarVolume(ticker);
  if (!vol || vol.barCount < minBars || vol.avgDollarVolume < minDollarVolume) {
    return {
      passes: false,
      reason: 'low-volume',
      detail: vol
        ? `avgDollarVolume ${vol.avgDollarVolume.toFixed(0)} (${vol.barCount} bars) < ${minDollarVolume}`
        : 'no DailyBar history',
    };
  }

  // Tier-1 news coverage in last 30d.
  const hasNews = await deps.hasTier1NewsLast30d(ticker);
  if (!hasNews) {
    return {
      passes: false,
      reason: 'no-tier1-news',
      detail: 'no tier-1 article in last 30d',
    };
  }

  return { passes: true };
}

/**
 * Lottery auto-detect helper — Phase 17.6 final bullet.
 *
 * Caller (poller or nightly job) supplies the ticker's last 20 DailyBars.
 * We compute the most recent close + the 20-day realized volatility
 * (annualized) from log returns, and return whether the ticker meets the
 * lottery criteria: price < $5 AND realized vol > 100% annualized.
 *
 * Returns null when there isn't enough data to decide; callers should leave
 * the existing isLottery flag untouched in that case.
 */
export interface LotteryDetectInput {
  bars: ReadonlyArray<{ close: number; date: Date }>;
}

export interface LotteryDetectResult {
  shouldFlag: boolean;
  latestPrice: number;
  realizedVolAnnualized: number;
}

export function detectLotteryFromBars(
  input: LotteryDetectInput,
): LotteryDetectResult | null {
  const sorted = [...input.bars]
    .filter(
      (b) =>
        b &&
        Number.isFinite(b.close) &&
        b.close > 0 &&
        b.date instanceof Date &&
        !Number.isNaN(b.date.getTime()),
    )
    .sort((a, b) => a.date.getTime() - b.date.getTime());
  if (sorted.length < 10) return null;

  const closes = sorted.map((b) => b.close);
  const last = closes[closes.length - 1];
  if (last === undefined || last <= 0) return null;

  // Daily log returns.
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    const curr = closes[i];
    if (prev === undefined || curr === undefined) continue;
    if (prev <= 0 || curr <= 0) continue;
    returns.push(Math.log(curr / prev));
  }
  if (returns.length < 5) return null;

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  let varianceSum = 0;
  for (const r of returns) varianceSum += (r - mean) ** 2;
  const dailyStd = Math.sqrt(varianceSum / Math.max(1, returns.length - 1));
  // Annualize using 252 trading days.
  const annualVol = dailyStd * Math.sqrt(252);

  return {
    shouldFlag: last < 5 && annualVol > 1.0,
    latestPrice: last,
    realizedVolAnnualized: annualVol,
  };
}
