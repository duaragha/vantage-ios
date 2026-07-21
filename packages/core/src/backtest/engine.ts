/**
 * Backtest harness.
 *
 * `runBacktest(config)` replays a strategy over a historical Tiingo EOD window
 * and returns a full BacktestResult — trades, monthly snapshots, equity
 * curve, final value, total return, SPY benchmark, CAGR, max drawdown.
 *
 * Determinism
 * -----------
 * The production monthly-allocation digest calls Sonnet, but a backtest needs
 * reproducibility. We stand in with a **deterministic equal-weight allocator**
 * (see `strategies.equalWeightAllocate`) that respects `singlePositionCapPct`
 * and `sectorCapPct`. This is intentionally a simpler proxy for the
 * LLM-powered path; it trades realism for repeatability. If a run with the
 * same config produces different numbers, it's a bug — not model drift.
 *
 * Algorithm
 * ---------
 *   a. Pre-fetch Tiingo daily bars for every candidate + seed ticker + SPY in
 *      one burst (Promise.all, small enough slate that Tiingo's 500 uniq/hr
 *      cap isn't an issue for personal use).
 *   b. Iterate trading days on SPY's bar calendar — any weekday with no SPY
 *      bar (holidays) is skipped.
 *   c. On the first trading day on-or-after each month-start, the strategy
 *      fires:
 *        - `monthly-allocation`: add monthlyBudgetUsd to cash, then propose
 *          equal-weight buys across the candidate universe, respecting caps.
 *        - `rebalance-only`: no fresh cash; just trim any single-position
 *          breaches.
 *   d. At every month-end trading day, snapshot the portfolio (cash +
 *      positions-at-close-price).
 *   e. Every trading day writes an equity-curve point (portfolio value and
 *      the SPY-equivalent that same cash would have bought on startDate).
 *   f. Missing bars for a candidate on a given day: the position continues at
 *      its last-known close; new buys that day skip that ticker.
 *   g. On endDate we persist a `BacktestRun` row (unless `persist: false`).
 *
 * Tests / injection
 * -----------------
 * Callers can inject `barsByTicker` directly (skipping Tiingo) and/or
 * `persist: false` to avoid DB writes — both are used by unit tests.
 */

import { prisma, type BacktestRun as BacktestRunRow, type Prisma } from '@vantage/db';
import { TiingoAdapter } from '@vantage/sources';

import { computeCAGR, computeDrawdown, computeSharpeApprox, seriesToReturns } from './metrics.js';
import { equalWeightAllocate, trimToCapOnly } from './strategies.js';
import type {
  BacktestConfig,
  BacktestEquityPoint,
  BacktestPosition,
  BacktestResult,
  BacktestSnapshot,
  BacktestTrade,
} from './types.js';

export type {
  BacktestConfig,
  BacktestResult,
  BacktestSnapshot,
  BacktestTrade,
  BacktestEquityPoint,
  BacktestCaps,
  BacktestStrategy,
  SeedPosition,
  BacktestPosition,
} from './types.js';

// ---------------------------------------------------------------------------
// Options + logger
// ---------------------------------------------------------------------------

export interface RunBacktestLogger {
  info?: (obj: unknown, msg?: string) => void;
  warn?: (obj: unknown, msg?: string) => void;
  error?: (obj: unknown, msg?: string) => void;
  debug?: (obj: unknown, msg?: string) => void;
}

export interface RunBacktestOptions {
  log?: RunBacktestLogger;
  /** Inject pre-fetched bars (tests). Key = uppercase ticker. */
  barsByTicker?: Record<string, DailyBar[]>;
  /** Skip Prisma persistence (tests / previews). Default true. */
  persist?: boolean;
  /** Override the Tiingo adapter (tests). */
  tiingo?: Pick<TiingoAdapter, 'getDailyPrices'>;
}

export interface DailyBar {
  date: Date;
  close: number;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export async function runBacktest(
  config: BacktestConfig,
  opts: RunBacktestOptions = {},
): Promise<BacktestResult> {
  const log = opts.log ?? defaultLog;
  const persist = opts.persist !== false;

  validateConfig(config);

  // (a) Fetch bars
  const universe = buildTickerUniverse(config);
  const barsByTicker =
    opts.barsByTicker ??
    (await fetchAllBars(universe, config.startDate, config.endDate, log, opts.tiingo));

  const spyBars = barsByTicker['SPY'] ?? [];
  if (spyBars.length === 0) {
    throw new Error('[backtest] SPY has no bars — cannot compute benchmark or trading calendar');
  }

  // Catalyst-driven strategy has its own loop — replay historical catalyst
  // MarketEvents and exit positions after `holdingDays`. Falls through to the
  // standard month-start strategy otherwise.
  if (config.strategy === 'catalyst-driven') {
    return runCatalystBacktest(config, barsByTicker, spyBars, log, persist);
  }

  // (b) Trading calendar from SPY
  const tradingDays = spyBars.map((b) => b.date);

  // Pre-build fast lookup: bar close by (ticker, isoDate).
  const barLookup = buildBarLookup(barsByTicker);

  // Running state
  let cash = config.initialCashUsd;
  const positions: BacktestPosition[] = (config.seedPositions ?? []).map((s) => ({
    ticker: s.ticker.toUpperCase(),
    shares: s.shares,
    avgCost: s.avgCost,
  }));

  const entries: BacktestTrade[] = [];
  const exits: BacktestTrade[] = [];
  const snapshots: BacktestSnapshot[] = [];
  const equityCurve: BacktestEquityPoint[] = [];

  // SPY benchmark — buy-and-hold from first trading day.
  const spyStartClose = spyBars[0]!.close;
  const spyShares = spyStartClose > 0 ? config.initialCashUsd / spyStartClose : 0;

  // Track which calendar months have already triggered strategy.
  const firedMonths = new Set<string>();

  // Walk trading days
  const seenMonthEnd = new Map<string, Date>(); // year-month → last day
  for (const d of tradingDays) {
    seenMonthEnd.set(monthKey(d), d); // last-write-wins = actual last trading day of month
  }

  for (let i = 0; i < tradingDays.length; i += 1) {
    const day = tradingDays[i]!;
    const todayPrices = pricesOnDay(universe, day, barLookup);

    const mk = monthKey(day);

    // -- (c) Month-start strategy fire ------------------------------------
    // Fire on the FIRST trading day of each calendar month encountered.
    if (!firedMonths.has(mk)) {
      firedMonths.add(mk);
      if (config.strategy === 'monthly-allocation') {
        cash += config.monthlyBudgetUsd;
        const alloc = equalWeightAllocate({
          date: day,
          cashUsd: cash,
          candidates: config.candidateUniverse ?? [],
          prices: todayPrices,
          caps: config.caps,
          currentPositions: positions,
          ...(config.sectors ? { sectors: config.sectors } : {}),
        });
        cash = alloc.remainingCash;
        for (const t of alloc.trades) {
          entries.push(t);
          applyTradeToPositions(positions, t);
        }
      } else {
        const trim = trimToCapOnly({
          date: day,
          positions,
          prices: todayPrices,
          caps: config.caps,
          ...(config.sectors ? { sectors: config.sectors } : {}),
          cashUsd: cash,
        });
        for (const t of trim.trades) {
          if (t.kind === 'trim' || t.kind === 'exit') {
            exits.push(t);
            cash += t.dollars;
            applyTradeToPositions(positions, t);
          }
        }
      }
    }

    // -- (d) Month-end snapshot -------------------------------------------
    const monthEnd = seenMonthEnd.get(mk);
    if (monthEnd && sameDay(monthEnd, day)) {
      snapshots.push(snapshotPortfolio(day, cash, positions, todayPrices));
    }

    // -- (e) Equity curve -------------------------------------------------
    const spyClose = barLookup.get(keyOf('SPY', day))?.close ?? NaN;
    const spyValue =
      Number.isFinite(spyClose) && spyClose > 0
        ? spyShares * spyClose
        : (equityCurve[equityCurve.length - 1]?.spyValueUsd ?? config.initialCashUsd);

    const portfolioValue = valuePortfolio(cash, positions, todayPrices);
    equityCurve.push({
      date: new Date(day.getTime()),
      valueUsd: round2(portfolioValue),
      spyValueUsd: round2(spyValue),
    });
  }

  // (f) Final metrics
  const finalValueUsd = equityCurve.length
    ? equityCurve[equityCurve.length - 1]!.valueUsd
    : config.initialCashUsd;
  const totalReturnPct =
    config.initialCashUsd > 0
      ? ((finalValueUsd - config.initialCashUsd) / config.initialCashUsd) * 100
      : 0;
  const spyFinal = equityCurve.length
    ? equityCurve[equityCurve.length - 1]!.spyValueUsd
    : config.initialCashUsd;
  const spyReturnPct =
    config.initialCashUsd > 0
      ? ((spyFinal - config.initialCashUsd) / config.initialCashUsd) * 100
      : 0;

  const values = equityCurve.map((p) => p.valueUsd);
  const maxDrawdownPct = computeDrawdown(values);
  const years = diffYears(config.startDate, config.endDate);
  const cagr = computeCAGR(config.initialCashUsd, finalValueUsd, years);
  const sharpeApprox = computeSharpeApprox(seriesToReturns(values));

  const result: BacktestResult = {
    entries,
    exits,
    monthlySnapshots: snapshots,
    finalValueUsd: round2(finalValueUsd),
    totalReturnPct: round2(totalReturnPct),
    spyReturnPct: round2(spyReturnPct),
    maxDrawdownPct: round2(maxDrawdownPct),
    cagr: round2(cagr),
    sharpeApprox: round2(sharpeApprox),
    equityCurve,
    backtestRunId: null,
  };

  // (g) Persist
  if (persist) {
    try {
      const row = await persistBacktestRun(config, result);
      result.backtestRunId = row.id;
      log.info?.(
        { backtestRunId: row.id, finalValueUsd: result.finalValueUsd },
        '[backtest] persisted',
      );
    } catch (err) {
      log.error?.({ err: err instanceof Error ? err.message : err }, '[backtest] persist failed');
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Catalyst-driven backtest — Phase 17.10
//
// Replays historical MarketEvents of catalyst kinds (InsiderCluster,
// EarningsBeat, Material8K, AnalystUpgrade) inside the [startDate, endDate]
// window. On each event day, simulate buying the corresponding ticker at the
// NEXT trading day's open (close as a proxy if open is unavailable). Equal-
// weight allocate across all catalyst events on that day, capped at
// catalystMaxPerDay (default 2). Hold for `holdingDays` trading days, then
// sell at that day's close. Track entries, exits, snapshots, equity curve.
// ---------------------------------------------------------------------------

async function runCatalystBacktest(
  config: BacktestConfig,
  barsByTicker: Record<string, DailyBar[]>,
  spyBars: DailyBar[],
  log: RunBacktestLogger,
  persist: boolean,
): Promise<BacktestResult> {
  const tradingDays = spyBars.map((b) => b.date);
  const holdingDays = Math.max(1, Math.floor(config.holdingDays ?? 30));
  const maxPerDay = Math.max(1, Math.floor(config.catalystMaxPerDay ?? 2));

  // Pull historical catalyst events from the DB.
  const catalystKinds = ['InsiderCluster', 'EarningsBeat', 'Material8K', 'AnalystUpgrade'];
  let events: Array<{
    id: number;
    kind: string;
    ticker: string;
    occurredAt: Date;
  }> = [];
  try {
    const rows = await prisma.marketEvent.findMany({
      where: {
        kind: {
          in: catalystKinds as Array<
            'InsiderCluster' | 'EarningsBeat' | 'Material8K' | 'AnalystUpgrade'
          >,
        },
        occurredAt: { gte: config.startDate, lte: config.endDate },
        ticker: { not: null },
      },
      orderBy: { occurredAt: 'asc' },
      select: { id: true, kind: true, ticker: true, occurredAt: true },
    });
    events = rows
      .filter((r): r is typeof r & { ticker: string } => r.ticker !== null)
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        ticker: r.ticker.toUpperCase(),
        occurredAt: r.occurredAt,
      }));
  } catch (err) {
    log.warn?.(
      { err: err instanceof Error ? err.message : err },
      '[backtest:catalyst] MarketEvent query failed — running with empty catalyst stream',
    );
  }

  // Group events by trading-day key for fast lookup.
  const eventsByDay = new Map<string, Array<{ ticker: string; kind: string }>>();
  for (const e of events) {
    // Find the next trading day after the event's day.
    const nextDay = nextTradingDayAtOrAfter(tradingDays, e.occurredAt);
    if (!nextDay) continue;
    const key = isoDay(nextDay);
    const arr = eventsByDay.get(key);
    if (arr) arr.push({ ticker: e.ticker, kind: e.kind });
    else eventsByDay.set(key, [{ ticker: e.ticker, kind: e.kind }]);
  }

  const barLookup = buildBarLookup(barsByTicker);

  let cash = config.initialCashUsd;
  const positions: BacktestPosition[] = (config.seedPositions ?? []).map((s) => ({
    ticker: s.ticker.toUpperCase(),
    shares: s.shares,
    avgCost: s.avgCost,
  }));
  // Track exit schedule: at this trading-day, sell N shares of ticker.
  const exitsByDay = new Map<
    string,
    Array<{ ticker: string; shares: number; entryPrice: number }>
  >();

  const entries: BacktestTrade[] = [];
  const exitTrades: BacktestTrade[] = [];
  const snapshots: BacktestSnapshot[] = [];
  const equityCurve: BacktestEquityPoint[] = [];

  const spyStartClose = spyBars[0]!.close;
  const spyShares = spyStartClose > 0 ? config.initialCashUsd / spyStartClose : 0;

  const seenMonthEnd = new Map<string, Date>();
  for (const d of tradingDays) seenMonthEnd.set(monthKey(d), d);

  for (let i = 0; i < tradingDays.length; i++) {
    const day = tradingDays[i]!;
    const dayKey = isoDay(day);
    const universe = Array.from(barsByTicker ? Object.keys(barsByTicker) : []);
    const todayPrices = pricesOnDay(universe, day, barLookup);

    // -- Catalyst entries on this day --------------------------------------
    const todayEvents = eventsByDay.get(dayKey) ?? [];
    if (todayEvents.length > 0) {
      // Dedup tickers — one buy per ticker per day.
      const uniqueTickers = Array.from(new Set(todayEvents.map((e) => e.ticker.toUpperCase())));
      // Skip tickers already held (catalyst engine targets unheld).
      const eligible = uniqueTickers.filter(
        (t) => !positions.some((p) => p.ticker.toUpperCase() === t),
      );
      const cappedTickers = eligible.slice(0, maxPerDay);
      if (cappedTickers.length > 0 && cash > 0) {
        const allocPerBuy = cash / cappedTickers.length;
        for (const ticker of cappedTickers) {
          const price = todayPrices[ticker];
          if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
            continue;
          }
          const shares = allocPerBuy / price;
          if (shares <= 0) continue;
          const cost = shares * price;
          cash -= cost;
          const trade: BacktestTrade = {
            date: new Date(day.getTime()),
            ticker,
            kind: 'buy',
            shares,
            price,
            dollars: cost,
            rationale: `catalyst-driven entry (kind=${todayEvents.find((e) => e.ticker.toUpperCase() === ticker)?.kind ?? 'mixed'})`,
          };
          entries.push(trade);
          applyTradeToPositions(positions, trade);
          // Schedule exit `holdingDays` trading days from now.
          const exitDayIndex = Math.min(i + holdingDays, tradingDays.length - 1);
          const exitDay = tradingDays[exitDayIndex]!;
          const exitKey = isoDay(exitDay);
          const arr = exitsByDay.get(exitKey);
          const entry = { ticker, shares, entryPrice: price };
          if (arr) arr.push(entry);
          else exitsByDay.set(exitKey, [entry]);
        }
      }
    }

    // -- Scheduled exits today --------------------------------------------
    const scheduledExits = exitsByDay.get(dayKey) ?? [];
    for (const exit of scheduledExits) {
      const price = todayPrices[exit.ticker];
      if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
        // No bar today — postpone to next trading day.
        if (i + 1 < tradingDays.length) {
          const next = tradingDays[i + 1]!;
          const nextKey = isoDay(next);
          const arr = exitsByDay.get(nextKey);
          if (arr) arr.push(exit);
          else exitsByDay.set(nextKey, [exit]);
        }
        continue;
      }
      const dollars = exit.shares * price;
      cash += dollars;
      const trade: BacktestTrade = {
        date: new Date(day.getTime()),
        ticker: exit.ticker,
        kind: 'exit',
        shares: exit.shares,
        price,
        dollars,
        rationale: `catalyst-driven exit (held ${holdingDays}d, entry $${exit.entryPrice.toFixed(2)})`,
      };
      exitTrades.push(trade);
      applyTradeToPositions(positions, trade);
    }
    exitsByDay.delete(dayKey);

    // -- Month-end snapshot -----------------------------------------------
    const monthEnd = seenMonthEnd.get(monthKey(day));
    if (monthEnd && sameDay(monthEnd, day)) {
      snapshots.push(snapshotPortfolio(day, cash, positions, todayPrices));
    }

    // -- Equity curve ------------------------------------------------------
    const spyClose = barLookup.get(keyOf('SPY', day))?.close ?? NaN;
    const spyValue =
      Number.isFinite(spyClose) && spyClose > 0
        ? spyShares * spyClose
        : (equityCurve[equityCurve.length - 1]?.spyValueUsd ?? config.initialCashUsd);
    const portfolioValue = valuePortfolio(cash, positions, todayPrices);
    equityCurve.push({
      date: new Date(day.getTime()),
      valueUsd: round2(portfolioValue),
      spyValueUsd: round2(spyValue),
    });
  }

  const finalValueUsd = equityCurve.length
    ? equityCurve[equityCurve.length - 1]!.valueUsd
    : config.initialCashUsd;
  const totalReturnPct =
    config.initialCashUsd > 0
      ? ((finalValueUsd - config.initialCashUsd) / config.initialCashUsd) * 100
      : 0;
  const spyFinal = equityCurve.length
    ? equityCurve[equityCurve.length - 1]!.spyValueUsd
    : config.initialCashUsd;
  const spyReturnPct =
    config.initialCashUsd > 0
      ? ((spyFinal - config.initialCashUsd) / config.initialCashUsd) * 100
      : 0;
  const values = equityCurve.map((p) => p.valueUsd);
  const maxDrawdownPct = computeDrawdown(values);
  const years = diffYears(config.startDate, config.endDate);
  const cagr = computeCAGR(config.initialCashUsd, finalValueUsd, years);
  const sharpeApprox = computeSharpeApprox(seriesToReturns(values));

  const result: BacktestResult = {
    entries,
    exits: exitTrades,
    monthlySnapshots: snapshots,
    finalValueUsd: round2(finalValueUsd),
    totalReturnPct: round2(totalReturnPct),
    spyReturnPct: round2(spyReturnPct),
    maxDrawdownPct: round2(maxDrawdownPct),
    cagr: round2(cagr),
    sharpeApprox: round2(sharpeApprox),
    equityCurve,
    backtestRunId: null,
  };

  if (persist) {
    try {
      const row = await persistBacktestRun(config, result);
      result.backtestRunId = row.id;
      log.info?.(
        { backtestRunId: row.id, finalValueUsd: result.finalValueUsd },
        '[backtest:catalyst] persisted',
      );
    } catch (err) {
      log.error?.(
        { err: err instanceof Error ? err.message : err },
        '[backtest:catalyst] persist failed',
      );
    }
  }
  return result;
}

function nextTradingDayAtOrAfter(tradingDays: ReadonlyArray<Date>, occurredAt: Date): Date | null {
  const target = occurredAt.getTime();
  // Buy at NEXT-day-open: find the first trading day strictly after the
  // event's calendar day (treats same-day events as "next session", which
  // matches how Form-4 lag works in reality).
  const eventDay = startOfDay(occurredAt);
  for (const d of tradingDays) {
    if (d.getTime() > eventDay.getTime()) return d;
    // If event lands exactly on a trading day's midnight (UTC), still treat
    // it as "next session" — events fire DURING the session, so the next
    // open is the next bar.
    if (d.getTime() === eventDay.getTime() && target > d.getTime()) {
      // continue — we want the strictly-next session.
      continue;
    }
  }
  return null;
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async function persistBacktestRun(
  config: BacktestConfig,
  result: BacktestResult,
): Promise<BacktestRunRow> {
  const cfgJson: Prisma.InputJsonValue = {
    startDate: config.startDate.toISOString(),
    endDate: config.endDate.toISOString(),
    strategy: config.strategy,
    initialCashUsd: config.initialCashUsd,
    monthlyBudgetUsd: config.monthlyBudgetUsd,
    caps: {
      singlePositionCapPct: config.caps.singlePositionCapPct,
      sectorCapPct: config.caps.sectorCapPct,
    },
    seedPositions: (config.seedPositions ?? []).map((s) => ({
      ticker: s.ticker,
      shares: s.shares,
      avgCost: s.avgCost,
    })),
    candidateUniverse: [...(config.candidateUniverse ?? [])],
    sectors: config.sectors ?? {},
    // Metadata so anyone reading the row can tell it was a deterministic run.
    deterministic: true,
    engineVersion: 1,
  };

  const resultJson: Prisma.InputJsonValue = {
    entries: result.entries.map(serializeTrade),
    exits: result.exits.map(serializeTrade),
    monthlySnapshots: result.monthlySnapshots.map(serializeSnapshot),
    finalValueUsd: result.finalValueUsd,
    totalReturnPct: result.totalReturnPct,
    spyReturnPct: result.spyReturnPct,
    maxDrawdownPct: result.maxDrawdownPct,
    cagr: result.cagr,
    sharpeApprox: result.sharpeApprox ?? 0,
    equityCurve: result.equityCurve.map((p) => ({
      date: p.date.toISOString(),
      valueUsd: p.valueUsd,
      spyValueUsd: p.spyValueUsd,
    })),
  };

  return prisma.backtestRun.create({
    data: {
      startDate: config.startDate,
      endDate: config.endDate,
      config: cfgJson,
      result: resultJson,
    },
  });
}

function serializeTrade(t: BacktestTrade): Prisma.InputJsonValue {
  return {
    date: t.date.toISOString(),
    ticker: t.ticker,
    kind: t.kind,
    shares: t.shares,
    price: t.price,
    dollars: t.dollars,
    rationale: t.rationale,
  };
}

function serializeSnapshot(s: BacktestSnapshot): Prisma.InputJsonValue {
  return {
    date: s.date.toISOString(),
    cashUsd: s.cashUsd,
    totalValueUsd: s.totalValueUsd,
    positions: s.positions.map((p) => ({
      ticker: p.ticker,
      shares: p.shares,
      valueUsd: p.valueUsd,
    })),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateConfig(config: BacktestConfig): void {
  if (!(config.startDate instanceof Date) || !Number.isFinite(config.startDate.getTime())) {
    throw new Error('[backtest] invalid startDate');
  }
  if (!(config.endDate instanceof Date) || !Number.isFinite(config.endDate.getTime())) {
    throw new Error('[backtest] invalid endDate');
  }
  if (config.endDate <= config.startDate) {
    throw new Error('[backtest] endDate must be strictly after startDate');
  }
  if (!['monthly-allocation', 'rebalance-only', 'catalyst-driven'].includes(config.strategy)) {
    throw new Error('[backtest] invalid strategy');
  }
  if (!Number.isFinite(config.initialCashUsd) || config.initialCashUsd < 0) {
    throw new Error('[backtest] initialCashUsd must be ≥ 0');
  }
  if (!Number.isFinite(config.monthlyBudgetUsd) || config.monthlyBudgetUsd < 0) {
    throw new Error('[backtest] monthlyBudgetUsd must be ≥ 0');
  }
  if (!config.caps || typeof config.caps !== 'object') {
    throw new Error('[backtest] caps are required');
  }
  if (
    !Number.isFinite(config.caps.singlePositionCapPct) ||
    config.caps.singlePositionCapPct <= 0 ||
    config.caps.singlePositionCapPct > 100
  ) {
    throw new Error('[backtest] singlePositionCapPct must be in (0,100]');
  }
  if (
    !Number.isFinite(config.caps.sectorCapPct) ||
    config.caps.sectorCapPct <= 0 ||
    config.caps.sectorCapPct > 100
  ) {
    throw new Error('[backtest] sectorCapPct must be in (0,100]');
  }

  const tickerPattern = /^[A-Z0-9][A-Z0-9.-]{0,23}$/;
  const seedPositions = config.seedPositions ?? [];
  if (!Array.isArray(seedPositions) || seedPositions.length > 500) {
    throw new Error('[backtest] seedPositions must contain at most 500 rows');
  }
  const seenSeeds = new Set<string>();
  for (const seed of seedPositions) {
    const ticker = typeof seed?.ticker === 'string' ? seed.ticker.trim().toUpperCase() : '';
    if (!tickerPattern.test(ticker)) {
      throw new Error('[backtest] seed position has an invalid ticker');
    }
    if (seenSeeds.has(ticker)) {
      throw new Error(`[backtest] seed position ${ticker} is duplicated`);
    }
    if (!Number.isFinite(seed.shares) || seed.shares <= 0) {
      throw new Error(`[backtest] seed position ${ticker} shares must be greater than 0`);
    }
    if (!Number.isFinite(seed.avgCost) || seed.avgCost < 0) {
      throw new Error(`[backtest] seed position ${ticker} avgCost must be at least 0`);
    }
    seenSeeds.add(ticker);
  }

  const candidateUniverse = config.candidateUniverse ?? [];
  if (!Array.isArray(candidateUniverse) || candidateUniverse.length > 2_000) {
    throw new Error('[backtest] candidateUniverse must contain at most 2000 tickers');
  }
  for (const rawTicker of candidateUniverse) {
    const ticker = typeof rawTicker === 'string' ? rawTicker.trim().toUpperCase() : '';
    if (!tickerPattern.test(ticker)) {
      throw new Error('[backtest] candidateUniverse contains an invalid ticker');
    }
  }

  if (config.sectors !== undefined) {
    if (
      typeof config.sectors !== 'object' ||
      config.sectors === null ||
      Array.isArray(config.sectors) ||
      Object.keys(config.sectors).length > 2_000
    ) {
      throw new Error('[backtest] sectors must map at most 2000 tickers');
    }
    for (const [rawTicker, rawSector] of Object.entries(config.sectors)) {
      const ticker = rawTicker.trim().toUpperCase();
      if (!tickerPattern.test(ticker)) {
        throw new Error('[backtest] sectors contains an invalid ticker');
      }
      if (rawSector !== null) {
        const sector = typeof rawSector === 'string' ? rawSector.trim() : '';
        if (sector.length === 0 || sector.length > 100) {
          throw new Error(`[backtest] sector for ${ticker} must contain 1 to 100 characters`);
        }
      }
    }
  }

  if (
    config.holdingDays !== undefined &&
    (!Number.isInteger(config.holdingDays) || config.holdingDays < 1 || config.holdingDays > 2_520)
  ) {
    throw new Error('[backtest] holdingDays must be an integer from 1 to 2520');
  }
  if (
    config.catalystMaxPerDay !== undefined &&
    (!Number.isInteger(config.catalystMaxPerDay) ||
      config.catalystMaxPerDay < 1 ||
      config.catalystMaxPerDay > 100)
  ) {
    throw new Error('[backtest] catalystMaxPerDay must be an integer from 1 to 100');
  }
}

function buildTickerUniverse(config: BacktestConfig): string[] {
  const s = new Set<string>(['SPY']);
  for (const t of config.candidateUniverse ?? []) s.add(t.toUpperCase());
  for (const t of config.seedPositions ?? []) s.add(t.ticker.toUpperCase());
  return [...s];
}

async function fetchAllBars(
  tickers: ReadonlyArray<string>,
  startDate: Date,
  endDate: Date,
  log: RunBacktestLogger,
  tiingo: Pick<TiingoAdapter, 'getDailyPrices'> | undefined,
): Promise<Record<string, DailyBar[]>> {
  const adapter = tiingo ?? new TiingoAdapter();
  const results: Record<string, DailyBar[]> = {};
  // Promise.all is fine — the rate limiter inside TiingoAdapter serializes
  // requests to its configured per-minute cap (16/min).
  const pulls = await Promise.all(
    tickers.map(async (t) => {
      try {
        const bars = await adapter.getDailyPrices(t, startDate, endDate);
        return [
          t,
          bars
            .map((b) => ({ date: startOfDay(b.timestamp), close: b.close }))
            .sort((a, b) => a.date.getTime() - b.date.getTime()),
        ] as const;
      } catch (err) {
        log.warn?.(
          { ticker: t, err: err instanceof Error ? err.message : err },
          '[backtest] failed to fetch bars — skipping ticker',
        );
        return [t, [] as DailyBar[]] as const;
      }
    }),
  );
  for (const [t, bars] of pulls) results[t] = bars;
  return results;
}

function buildBarLookup(barsByTicker: Record<string, DailyBar[]>): Map<string, DailyBar> {
  const out = new Map<string, DailyBar>();
  for (const [t, bars] of Object.entries(barsByTicker)) {
    for (const b of bars) out.set(keyOf(t, b.date), b);
  }
  return out;
}

function keyOf(ticker: string, date: Date): string {
  const iso = date.toISOString().slice(0, 10);
  return `${ticker.toUpperCase()}|${iso}`;
}

function pricesOnDay(
  tickers: ReadonlyArray<string>,
  day: Date,
  barLookup: Map<string, DailyBar>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of tickers) {
    const bar = barLookup.get(keyOf(t, day));
    if (bar && Number.isFinite(bar.close) && bar.close > 0) {
      out[t.toUpperCase()] = bar.close;
    }
  }
  return out;
}

function snapshotPortfolio(
  date: Date,
  cashUsd: number,
  positions: ReadonlyArray<BacktestPosition>,
  prices: Record<string, number>,
): BacktestSnapshot {
  const rows = positions
    .filter((p) => p.shares > 0)
    .map((p) => {
      const price = prices[p.ticker.toUpperCase()];
      const per =
        typeof price === 'number' && Number.isFinite(price) && price > 0 ? price : p.avgCost;
      return {
        ticker: p.ticker,
        shares: round4(p.shares),
        valueUsd: round2(p.shares * per),
      };
    });
  const totalValueUsd = round2(cashUsd + rows.reduce((s, r) => s + r.valueUsd, 0));
  return {
    date: new Date(date.getTime()),
    cashUsd: round2(cashUsd),
    positions: rows,
    totalValueUsd,
  };
}

function valuePortfolio(
  cashUsd: number,
  positions: ReadonlyArray<BacktestPosition>,
  prices: Record<string, number>,
): number {
  let total = cashUsd;
  for (const p of positions) {
    if (p.shares <= 0) continue;
    const price = prices[p.ticker.toUpperCase()];
    const per =
      typeof price === 'number' && Number.isFinite(price) && price > 0 ? price : p.avgCost;
    total += p.shares * per;
  }
  return total;
}

function applyTradeToPositions(positions: BacktestPosition[], trade: BacktestTrade): void {
  const ticker = trade.ticker.toUpperCase();
  const existing = positions.find((p) => p.ticker.toUpperCase() === ticker);
  if (trade.kind === 'buy') {
    if (existing) {
      const totalShares = existing.shares + trade.shares;
      const totalCost = existing.shares * existing.avgCost + trade.shares * trade.price;
      existing.shares = totalShares;
      existing.avgCost = totalShares > 0 ? totalCost / totalShares : 0;
    } else {
      positions.push({ ticker, shares: trade.shares, avgCost: trade.price });
    }
    return;
  }
  // trim / exit
  if (!existing) return;
  existing.shares = Math.max(0, existing.shares - trade.shares);
  if (existing.shares <= 1e-6) {
    const idx = positions.indexOf(existing);
    if (idx >= 0) positions.splice(idx, 1);
  }
}

function monthKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function startOfDay(d: Date): Date {
  const dd = new Date(d.getTime());
  dd.setUTCHours(0, 0, 0, 0);
  return dd;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

function diffYears(a: Date, b: Date): number {
  const ms = b.getTime() - a.getTime();
  return ms / (365.25 * 24 * 3600 * 1000);
}

function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10000) / 10000;
}

const defaultLog: RunBacktestLogger = {
  info: (obj, msg) => console.info(msg ?? '', obj),
  warn: (obj, msg) => console.warn(msg ?? '', obj),
  error: (obj, msg) => console.error(msg ?? '', obj),
};
