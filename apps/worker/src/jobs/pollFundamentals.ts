/**
 * Poll fundamentals — SEC EDGAR XBRL company-facts + Finnhub /stock/metric.
 *
 * For the top 1000 US-listed names by market cap (excluding lottery tags), we:
 *   1. Resolve ticker → CIK (cached on TickerUniverse.cik; ticker→CIK map fetched
 *      once per run for any rows still missing a CIK).
 *   2. Pull SEC company-facts and write the last 8 quarters into
 *      FundamentalsSnapshot, one row per (ticker, periodEnd, periodType).
 *   3. Pull Finnhub basic financials and upsert ratios into TickerMetrics.
 *   4. Compute 30d avgVolume + avgDollarVolume from existing DailyBar rows.
 *
 * Default mode (force=false) is incremental: tickers with a TickerMetrics row
 * fetched in the last 7 days are skipped so the nightly cron only tops up what
 * went stale. `force=true` re-polls every name in the universe — the backfill
 * mode used after a deploy.
 *
 * Canadian listings (.TO/.NE/.V/.CN) take a separate yfinance path: SEC EDGAR
 * has no Canadian filers and Finnhub free-tier 403s on those symbols, so we
 * pull Yahoo's quoteSummary fundamentals instead. ETFs/funds on those exchanges
 * have no company financials and return null — they still score on price +
 * liquidity like any other ETF.
 */

import type { FastifyBaseLogger } from 'fastify';
import { prisma, type Prisma, type DailyBar } from '@vantage/db';
import {
  getCompanyFacts,
  getTickerCikMap,
  FinnhubAuthError,
  type CompanyFactsResult,
  type FactPoint,
  type TickerCikMap,
  type FinnhubBasicFinancials,
  type YFinanceFundamentals,
} from '@vantage/sources';
import { getUsdCadRate } from '@vantage/core';
import { getFinnhub, getYFinance } from '../lib/adapters.js';
import {
  buildTickerMetricsCreate,
  buildTickerMetricsUpdate,
} from '../lib/tickerMetricsPersistence.js';

const UNIVERSE_LIMIT = 1000;
const MIN_MARKET_CAP_USD = 500_000_000;
const STALE_DAYS = 7;
const QUARTERS_TO_KEEP = 8;
const LIQUIDITY_LOOKBACK_DAYS = 30;
const MIN_BARS_FOR_LIQUIDITY = 10;
const PROGRESS_EVERY = 100;

// CA universe bound. Unlike the US side we can't gate on market cap: the
// universe seeder only fills marketCapUsd for US (Finnhub) rows, so ~99% of CA
// rows have a null cap. We instead order by cap (known caps first) and take a
// generous slice — yfinance itself is the real filter, returning fundamentals
// for operating companies and null for ETFs/funds. The cap keeps the nightly
// run bounded against ~4.5k CA listings.
const CA_UNIVERSE_LIMIT = 1500;
// yfinance is unofficial — pace CA calls so we don't trip Yahoo rate limiting.
const YF_THROTTLE_MS = 300;

export interface PollFundamentalsResult {
  tickersConsidered: number;
  tickersFetched: number;
  snapshotsUpserted: number;
  metricsUpserted: number;
  cikLookupsDone: number;
  failedTickers: string[];
  skippedReason: string[];
}

export interface PollFundamentalsOptions {
  log?: FastifyBaseLogger | Console;
  /** Force re-poll all tickers, ignoring 7-day staleness check. */
  force?: boolean;
  /** Override the universe with an explicit list. */
  tickers?: string[];
}

interface UniverseRow {
  symbol: string;
  cik: string | null;
  currency: string;
}

export async function pollFundamentals(
  opts: PollFundamentalsOptions = {},
): Promise<PollFundamentalsResult> {
  const log = opts.log ?? console;
  const force = opts.force === true;

  const failedTickers: string[] = [];
  const skippedReasonSet = new Set<string>();
  let staleSkipCount = 0;
  let snapshotsUpserted = 0;
  let metricsUpserted = 0;
  let cikLookupsDone = 0;
  let tickersFetched = 0;

  // --- Universe selection ----------------------------------------------------
  const explicit =
    opts.tickers && opts.tickers.length > 0
      ? opts.tickers.map((t) => t.trim().toUpperCase()).filter((t) => t.length > 0)
      : null;

  let rows: UniverseRow[];
  if (explicit) {
    const fetched = await prisma.tickerUniverse.findMany({
      where: { symbol: { in: explicit } },
      select: { symbol: true, cik: true, currency: true },
    });
    rows = fetched;
  } else {
    // US names via SEC + Finnhub; CA names via yfinance. Query each universe
    // separately so the per-currency caps + floors stay independent.
    const usdCandidates = await prisma.tickerUniverse.findMany({
      where: {
        currency: 'USD',
        isLottery: false,
        marketCapUsd: { gte: MIN_MARKET_CAP_USD },
      },
      orderBy: { marketCapUsd: 'desc' },
      take: UNIVERSE_LIMIT,
      select: { symbol: true, cik: true, currency: true },
    });
    const caCandidates = await prisma.tickerUniverse.findMany({
      where: {
        currency: 'CAD',
        isLottery: false,
      },
      // Known caps first; nulls last. yfinance filters the rest (ETFs → null).
      orderBy: { marketCapUsd: { sort: 'desc', nulls: 'last' } },
      take: CA_UNIVERSE_LIMIT,
      select: { symbol: true, cik: true, currency: true },
    });
    rows = [...usdCandidates, ...caCandidates];
  }

  // Partition by currency. US → SEC/Finnhub path, CA → yfinance path. Any other
  // currency has no fundamentals source, so drop it with one summary log.
  const usdRows = rows.filter((r) => r.currency === 'USD');
  const caRows = rows.filter((r) => r.currency === 'CAD');
  const droppedOther = rows.length - usdRows.length - caRows.length;
  if (droppedOther > 0) {
    skippedReasonSet.add('unsupported-currency-skip');
    log.info?.({ count: droppedOther }, 'pollFundamentals: skipped unsupported-currency listings');
  }

  const tickersConsidered = usdRows.length + caRows.length;
  if (tickersConsidered === 0) {
    await syncKnownMarketCaps(log);
    return {
      tickersConsidered: 0,
      tickersFetched: 0,
      snapshotsUpserted: 0,
      metricsUpserted: 0,
      cikLookupsDone: 0,
      failedTickers,
      skippedReason: [...skippedReasonSet],
    };
  }

  // --- Staleness pre-filter --------------------------------------------------
  let workUsdRows: UniverseRow[];
  let workCaRows: UniverseRow[];
  if (force) {
    workUsdRows = usdRows;
    workCaRows = caRows;
  } else {
    const cutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000);
    const allSymbols = [...usdRows, ...caRows].map((r) => r.symbol);
    const fresh = await prisma.tickerMetrics.findMany({
      where: {
        ticker: { in: allSymbols },
        fetchedAt: { gt: cutoff },
      },
      select: { ticker: true },
    });
    const freshSet = new Set(fresh.map((r) => r.ticker));
    workUsdRows = usdRows.filter((r) => !freshSet.has(r.symbol));
    workCaRows = caRows.filter((r) => !freshSet.has(r.symbol));
    staleSkipCount = usdRows.length + caRows.length - workUsdRows.length - workCaRows.length;
    if (staleSkipCount > 0) {
      skippedReasonSet.add('stale-only-skip');
      log.info?.(
        { count: staleSkipCount, total: usdRows.length + caRows.length },
        'pollFundamentals: skipped tickers with fresh metrics',
      );
    }
  }

  // CIK map fetched lazily — only if at least one US work row is missing a cik.
  let tickerCikMap: TickerCikMap | null = null;
  const needsCikLookup = workUsdRows.some((r) => !r.cik);
  if (needsCikLookup) {
    try {
      tickerCikMap = await getTickerCikMap();
    } catch (err) {
      log.error?.(
        { err: err instanceof Error ? err.message : err },
        'pollFundamentals: getTickerCikMap failed',
      );
      tickerCikMap = {};
    }
  }

  const fn = getFinnhub();
  let finnhubAuthBroken = false;
  let done = 0;
  const usdTotal = workUsdRows.length;

  // --- US path: SEC EDGAR + Finnhub -----------------------------------------
  for (const row of workUsdRows) {
    done++;
    const ticker = row.symbol.toUpperCase();

    // --- Resolve CIK -------------------------------------------------------
    let cikNum: number | null = null;
    if (row.cik) {
      const parsed = Number(row.cik);
      if (Number.isFinite(parsed) && parsed > 0) cikNum = parsed;
    }
    if (cikNum === null && tickerCikMap) {
      const mapped = tickerCikMap[ticker];
      if (typeof mapped === 'number' && mapped > 0) {
        cikNum = mapped;
        try {
          await prisma.tickerUniverse.update({
            where: { symbol: ticker },
            data: { cik: String(mapped) },
          });
          cikLookupsDone++;
        } catch (err) {
          log.warn?.(
            { ticker, err: err instanceof Error ? err.message : err },
            'pollFundamentals: cik update failed',
          );
        }
      }
    }
    // --- SEC company-facts -------------------------------------------------
    // SEC and Finnhub are independent sources. A missing CIK or transient SEC
    // failure must not prevent ratios and liquidity from refreshing.
    let facts: CompanyFactsResult | null = null;
    if (cikNum === null) {
      skippedReasonSet.add('sec-cik-missing');
      log.warn?.({ ticker }, 'pollFundamentals: CIK missing — continuing with Finnhub');
    } else {
      try {
        facts = await getCompanyFacts(cikNum);
      } catch (err) {
        skippedReasonSet.add('sec-company-facts-failed');
        log.warn?.(
          { ticker, cik: cikNum, err: err instanceof Error ? err.message : err },
          'pollFundamentals: getCompanyFacts failed — continuing with Finnhub',
        );
      }
    }

    if (facts) {
      const snapshotRows = buildSnapshotRows(ticker, facts);
      for (const data of snapshotRows) {
        try {
          await prisma.fundamentalsSnapshot.upsert({
            where: {
              ticker_periodEnd_periodType: {
                ticker: data.ticker,
                periodEnd: data.periodEnd,
                periodType: data.periodType,
              },
            },
            create: data,
            update: data,
          });
          snapshotsUpserted++;
        } catch (err) {
          log.warn?.(
            {
              ticker,
              periodEnd: data.periodEnd,
              err: err instanceof Error ? err.message : err,
            },
            'pollFundamentals: snapshot upsert failed',
          );
        }
      }
    }

    // --- Finnhub basic financials -----------------------------------------
    let basics: FinnhubBasicFinancials | null = null;
    if (!finnhubAuthBroken) {
      try {
        basics = await fn.getBasicFinancials(ticker);
      } catch (err) {
        if (err instanceof FinnhubAuthError) {
          finnhubAuthBroken = true;
          skippedReasonSet.add('finnhub-auth');
          log.error?.(
            { err: err.message },
            'pollFundamentals: finnhub auth failed — disabling for the rest of this run',
          );
        } else {
          log.warn?.(
            { ticker, err: err instanceof Error ? err.message : err },
            'pollFundamentals: getBasicFinancials failed',
          );
        }
      }
    }

    // --- Liquidity from existing DailyBar ---------------------------------
    const liquidity = await computeLiquidity(ticker, log);

    // --- Upsert TickerMetrics ---------------------------------------------
    const metricsData = buildMetricsData(ticker, basics, liquidity);
    try {
      await prisma.tickerMetrics.upsert({
        where: { ticker },
        create: buildTickerMetricsCreate(
          metricsData as unknown as Record<string, unknown>,
          basics !== null,
        ) as unknown as Prisma.TickerMetricsCreateInput,
        update: buildTickerMetricsUpdate(
          metricsData as unknown as Record<string, unknown>,
          basics !== null,
        ) as Prisma.TickerMetricsUpdateInput,
      });
      metricsUpserted++;
    } catch (err) {
      log.warn?.(
        { ticker, err: err instanceof Error ? err.message : err },
        'pollFundamentals: metrics upsert failed',
      );
    }

    if (facts || basics) {
      tickersFetched++;
    } else {
      failedTickers.push(ticker);
    }

    if (done % PROGRESS_EVERY === 0) {
      log.info?.({ done, total: usdTotal }, 'pollFundamentals: progress');
    }
  }

  // --- CA path: yfinance -----------------------------------------------------
  if (workCaRows.length > 0) {
    const yf = getYFinance();
    // Yahoo reports CA market cap in CAD. Convert to USD once-per-run via the
    // shared fx rate so TickerMetrics.marketCapUsd stays a consistent unit
    // alongside the US (Finnhub-sourced) rows.
    let usdCadRate = 1;
    try {
      usdCadRate = await getUsdCadRate();
    } catch (err) {
      log.warn?.(
        { err: err instanceof Error ? err.message : err },
        'pollFundamentals: getUsdCadRate failed — CA marketCap left in CAD',
      );
    }

    let caDone = 0;
    const caTotal = workCaRows.length;
    for (const row of workCaRows) {
      caDone++;
      const ticker = row.symbol.toUpperCase();

      // Retry once on a null/throw — yfinance is unofficial and flakes. A
      // clean null means an ETF/fund with no company statements; two throws
      // mean an operational failure and must remain immediately retryable.
      let fundamentals: YFinanceFundamentals | null = null;
      let completedYahooAttempt = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) await sleep(YF_THROTTLE_MS);
        try {
          fundamentals = await yf.getFundamentals(ticker);
          completedYahooAttempt = true;
        } catch (err) {
          log.warn?.(
            { ticker, attempt: attempt + 1, err: err instanceof Error ? err.message : err },
            'pollFundamentals: Yahoo fundamentals attempt failed',
          );
        }
        if (fundamentals) break;
      }

      if (!fundamentals) {
        const liquidity = await computeLiquidity(ticker, log);
        const metricsData = {
          ...buildMetricsData(ticker, null, liquidity),
          source: completedYahooAttempt ? 'yfinance-no-fundamentals' : 'computed',
        };
        try {
          await prisma.tickerMetrics.upsert({
            where: { ticker },
            create: buildTickerMetricsCreate(
              metricsData as unknown as Record<string, unknown>,
              completedYahooAttempt,
            ) as unknown as Prisma.TickerMetricsCreateInput,
            update: buildTickerMetricsUpdate(
              metricsData as unknown as Record<string, unknown>,
              completedYahooAttempt,
            ) as Prisma.TickerMetricsUpdateInput,
          });
          metricsUpserted++;
          if (completedYahooAttempt) tickersFetched++;
        } catch (err) {
          log.warn?.(
            { ticker, err: err instanceof Error ? err.message : err },
            'pollFundamentals: no-fundamentals metrics upsert failed',
          );
        }

        if (completedYahooAttempt) {
          skippedReasonSet.add('yfinance-no-fundamentals');
        } else {
          failedTickers.push(ticker);
        }
        await sleep(YF_THROTTLE_MS);
        if (caDone % PROGRESS_EVERY === 0) {
          log.info?.({ done: caDone, total: caTotal }, 'pollFundamentals: CA progress');
        }
        continue;
      }

      // Quarterly snapshots (most recent first, up to 4).
      const snapshotRows = buildCaSnapshotRows(ticker, fundamentals);
      for (const data of snapshotRows) {
        try {
          await prisma.fundamentalsSnapshot.upsert({
            where: {
              ticker_periodEnd_periodType: {
                ticker: data.ticker,
                periodEnd: data.periodEnd,
                periodType: data.periodType,
              },
            },
            create: data,
            update: data,
          });
          snapshotsUpserted++;
        } catch (err) {
          log.warn?.(
            {
              ticker,
              periodEnd: data.periodEnd,
              err: err instanceof Error ? err.message : err,
            },
            'pollFundamentals: CA snapshot upsert failed',
          );
        }
      }

      const liquidity = await computeLiquidity(ticker, log);
      const metricsData = buildCaMetricsData(ticker, fundamentals, liquidity, usdCadRate);
      try {
        await prisma.tickerMetrics.upsert({
          where: { ticker },
          create: buildTickerMetricsCreate(
            metricsData as unknown as Record<string, unknown>,
            true,
          ) as unknown as Prisma.TickerMetricsCreateInput,
          update: buildTickerMetricsUpdate(
            metricsData as unknown as Record<string, unknown>,
            true,
          ) as Prisma.TickerMetricsUpdateInput,
        });
        await prisma.tickerUniverse.updateMany({
          where: { symbol: ticker },
          data: {
            ...(fundamentals.name ? { name: fundamentals.name } : {}),
            ...(fundamentals.sector || fundamentals.industry
              ? { sector: fundamentals.sector ?? fundamentals.industry }
              : {}),
            ...(metricsData.marketCapUsd !== null
              ? { marketCapUsd: metricsData.marketCapUsd }
              : {}),
          },
        });
        metricsUpserted++;
        tickersFetched++;
      } catch (err) {
        log.warn?.(
          { ticker, err: err instanceof Error ? err.message : err },
          'pollFundamentals: CA metrics upsert failed',
        );
      }

      await sleep(YF_THROTTLE_MS);
      if (caDone % PROGRESS_EVERY === 0) {
        log.info?.({ done: caDone, total: caTotal }, 'pollFundamentals: CA progress');
      }
    }
  }

  await syncKnownMarketCaps(log);

  return {
    tickersConsidered,
    tickersFetched,
    snapshotsUpserted,
    metricsUpserted,
    cikLookupsDone,
    failedTickers,
    skippedReason: [...skippedReasonSet],
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function syncKnownMarketCaps(log: FastifyBaseLogger | Console): Promise<number> {
  try {
    const synced = await prisma.$executeRaw`
      UPDATE "TickerUniverse" AS universe
      SET "marketCapUsd" = metrics."marketCapUsd"
      FROM "TickerMetrics" AS metrics
      WHERE metrics."ticker" = universe."symbol"
        AND metrics."marketCapUsd" IS NOT NULL
        AND universe."marketCapUsd" IS DISTINCT FROM metrics."marketCapUsd"
    `;
    if (synced > 0) {
      log.info?.({ synced }, 'pollFundamentals: synchronized universe market caps');
    }
    return synced;
  } catch (err) {
    log.warn?.(
      { err: err instanceof Error ? err.message : err },
      'pollFundamentals: universe market-cap synchronization failed',
    );
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SnapshotRow {
  ticker: string;
  periodEnd: Date;
  periodType: string;
  reportedAt: Date | null;
  revenue: Prisma.Decimal | null;
  costOfRevenue: Prisma.Decimal | null;
  grossProfit: Prisma.Decimal | null;
  operatingIncome: Prisma.Decimal | null;
  netIncome: Prisma.Decimal | null;
  epsBasic: Prisma.Decimal | null;
  epsDiluted: Prisma.Decimal | null;
  totalAssets: Prisma.Decimal | null;
  totalLiabilities: Prisma.Decimal | null;
  longTermDebt: Prisma.Decimal | null;
  shortTermDebt: Prisma.Decimal | null;
  totalEquity: Prisma.Decimal | null;
  cash: Prisma.Decimal | null;
  operatingCashFlow: Prisma.Decimal | null;
  freeCashFlow: Prisma.Decimal | null;
  capex: Prisma.Decimal | null;
  sharesOutstanding: Prisma.Decimal | null;
  source: string;
}

/**
 * Merge concept-keyed FactPoint arrays into one row per (periodEnd, periodType).
 * Keeps only the most recent QUARTERS_TO_KEEP periods, sorted desc by periodEnd —
 * enough for YoY + 5y growth deltas downstream.
 */
function buildSnapshotRows(ticker: string, facts: CompanyFactsResult): SnapshotRow[] {
  // Collect every unique (periodEnd ISO, periodType) pair we see across concepts.
  const periodKeys = new Map<string, { periodEnd: Date; periodType: 'Q' | 'FY' }>();
  const concepts = facts.facts;
  const allArrays: FactPoint[][] = [
    concepts.revenue,
    concepts.costOfRevenue,
    concepts.grossProfit,
    concepts.operatingIncome,
    concepts.netIncome,
    concepts.epsBasic,
    concepts.epsDiluted,
    concepts.totalAssets,
    concepts.totalLiabilities,
    concepts.longTermDebt,
    concepts.shortTermDebt,
    concepts.stockholdersEquity,
    concepts.cash,
    concepts.operatingCashFlow,
    concepts.capex,
    concepts.sharesOutstanding,
  ];
  for (const arr of allArrays) {
    for (const p of arr) {
      const key = `${p.periodEnd.toISOString()}|${p.periodType}`;
      if (!periodKeys.has(key)) {
        periodKeys.set(key, { periodEnd: p.periodEnd, periodType: p.periodType });
      }
    }
  }

  const sortedPeriods = [...periodKeys.values()].sort(
    (a, b) => b.periodEnd.getTime() - a.periodEnd.getTime(),
  );
  const recent = sortedPeriods.slice(0, QUARTERS_TO_KEEP);

  const rows: SnapshotRow[] = [];
  for (const period of recent) {
    const pickValue = (arr: FactPoint[]): { value: number; filedAt: Date } | null => {
      const hit = arr.find(
        (p) =>
          p.periodEnd.getTime() === period.periodEnd.getTime() &&
          p.periodType === period.periodType,
      );
      return hit ? { value: hit.value, filedAt: hit.filedAt } : null;
    };

    const revenue = pickValue(concepts.revenue);
    const costOfRevenue = pickValue(concepts.costOfRevenue);
    const grossProfit = pickValue(concepts.grossProfit);
    const operatingIncome = pickValue(concepts.operatingIncome);
    const netIncome = pickValue(concepts.netIncome);
    const epsBasic = pickValue(concepts.epsBasic);
    const epsDiluted = pickValue(concepts.epsDiluted);
    const totalAssets = pickValue(concepts.totalAssets);
    const totalLiabilities = pickValue(concepts.totalLiabilities);
    const longTermDebt = pickValue(concepts.longTermDebt);
    const shortTermDebt = pickValue(concepts.shortTermDebt);
    const stockholdersEquity = pickValue(concepts.stockholdersEquity);
    const cash = pickValue(concepts.cash);
    const operatingCashFlow = pickValue(concepts.operatingCashFlow);
    const capex = pickValue(concepts.capex);
    const sharesOutstanding = pickValue(concepts.sharesOutstanding);

    // Pick the latest filedAt across all concepts as the row's reportedAt.
    let reportedAt: Date | null = null;
    for (const v of [
      revenue,
      costOfRevenue,
      grossProfit,
      operatingIncome,
      netIncome,
      epsBasic,
      epsDiluted,
      totalAssets,
      totalLiabilities,
      longTermDebt,
      shortTermDebt,
      stockholdersEquity,
      cash,
      operatingCashFlow,
      capex,
      sharesOutstanding,
    ]) {
      if (v && (!reportedAt || v.filedAt.getTime() > reportedAt.getTime())) {
        reportedAt = v.filedAt;
      }
    }

    // CompanyFactsResult flips capex to a positive outflow already, so FCF =
    // operatingCashFlow - capex.
    const freeCashFlow = operatingCashFlow && capex ? operatingCashFlow.value - capex.value : null;

    rows.push({
      ticker,
      periodEnd: period.periodEnd,
      periodType: period.periodType,
      reportedAt,
      revenue: toDecimal(revenue?.value),
      costOfRevenue: toDecimal(costOfRevenue?.value),
      grossProfit: toDecimal(grossProfit?.value),
      operatingIncome: toDecimal(operatingIncome?.value),
      netIncome: toDecimal(netIncome?.value),
      epsBasic: toDecimal(epsBasic?.value),
      epsDiluted: toDecimal(epsDiluted?.value),
      totalAssets: toDecimal(totalAssets?.value),
      totalLiabilities: toDecimal(totalLiabilities?.value),
      longTermDebt: toDecimal(longTermDebt?.value),
      shortTermDebt: toDecimal(shortTermDebt?.value),
      totalEquity: toDecimal(stockholdersEquity?.value),
      cash: toDecimal(cash?.value),
      operatingCashFlow: toDecimal(operatingCashFlow?.value),
      freeCashFlow: toDecimal(freeCashFlow ?? undefined),
      capex: toDecimal(capex?.value),
      sharesOutstanding: toDecimal(sharesOutstanding?.value),
      source: 'sec-edgar',
    });
  }

  return rows;
}

function toDecimal(v: number | undefined | null): Prisma.Decimal | null {
  if (v === undefined || v === null || !Number.isFinite(v)) return null;
  // Prisma accepts string / number for Decimal columns. Use string form to
  // avoid float precision drift on large balance-sheet figures.
  // Re-imported via prisma value runtime — Prisma normalizes string input.
  return v as unknown as Prisma.Decimal;
}

interface LiquidityResult {
  avgVolume30d: number | null;
  avgDollarVolume30d: number | null;
}

async function computeLiquidity(
  ticker: string,
  log: FastifyBaseLogger | Console,
): Promise<LiquidityResult> {
  let bars: DailyBar[] = [];
  try {
    const since = new Date(Date.now() - LIQUIDITY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    bars = await prisma.dailyBar.findMany({
      where: { ticker, date: { gte: since } },
      orderBy: { date: 'desc' },
      take: LIQUIDITY_LOOKBACK_DAYS,
    });
  } catch (err) {
    log.warn?.(
      { ticker, err: err instanceof Error ? err.message : err },
      'pollFundamentals: dailyBar read failed',
    );
    return { avgVolume30d: null, avgDollarVolume30d: null };
  }

  if (bars.length < MIN_BARS_FOR_LIQUIDITY) {
    return { avgVolume30d: null, avgDollarVolume30d: null };
  }

  let volSum = 0;
  let dollarSum = 0;
  for (const b of bars) {
    const vol = Number(b.volume.toString());
    const close = Number(b.close.toString());
    if (Number.isFinite(vol)) volSum += vol;
    if (Number.isFinite(vol) && Number.isFinite(close)) dollarSum += vol * close;
  }
  return {
    avgVolume30d: volSum / bars.length,
    avgDollarVolume30d: dollarSum / bars.length,
  };
}

interface MetricsData {
  ticker: string;
  fetchedAt: Date;
  peTtm: number | null;
  pegTtm: number | null;
  psTtm: number | null;
  pbTtm: number | null;
  evToEbitda: number | null;
  roeTtm: number | null;
  roicTtm: number | null;
  roaTtm: number | null;
  grossMarginTtm: number | null;
  operatingMarginTtm: number | null;
  netMarginTtm: number | null;
  debtToEquity: number | null;
  currentRatio: number | null;
  quickRatio: number | null;
  dividendYieldTtm: number | null;
  dividendPayoutRatio: number | null;
  revenueGrowthYoy: number | null;
  revenueGrowth5y: number | null;
  epsGrowthYoy: number | null;
  epsGrowth5y: number | null;
  sharesOutstanding: Prisma.Decimal | null;
  marketCapUsd: Prisma.Decimal | null;
  beta: number | null;
  avgVolume30d: number | null;
  avgDollarVolume30d: number | null;
  source: string;
}

function buildMetricsData(
  ticker: string,
  basics: FinnhubBasicFinancials | null,
  liquidity: LiquidityResult,
): MetricsData {
  const m = basics?.metric ?? {};
  const get = (k: string): number | null => {
    const v = m[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  const firstFinite = (...keys: string[]): number | null => {
    for (const k of keys) {
      const v = get(k);
      if (v !== null) return v;
    }
    return null;
  };

  // Finnhub returns market cap in millions of USD.
  const mcapMillions = get('marketCapitalization');
  const mcapUsd = mcapMillions !== null ? toDecimal(mcapMillions * 1_000_000) : null;

  return {
    ticker,
    fetchedAt: new Date(),
    peTtm: firstFinite('peTTM', 'peNormalizedAnnual'),
    pegTtm: get('pegRatio'),
    psTtm: get('psTTM'),
    pbTtm: firstFinite('pbAnnual', 'pbQuarterly'),
    evToEbitda: get('evToEbitdaAnnual'),
    roeTtm: get('roeTTM'),
    roicTtm: get('roiTTM'),
    roaTtm: get('roaTTM'),
    grossMarginTtm: get('grossMarginTTM'),
    operatingMarginTtm: get('operatingMarginTTM'),
    netMarginTtm: get('netProfitMarginTTM'),
    debtToEquity: get('totalDebt/totalEquityAnnual'),
    currentRatio: get('currentRatioAnnual'),
    quickRatio: get('quickRatioAnnual'),
    dividendYieldTtm: get('dividendYieldIndicatedAnnual'),
    dividendPayoutRatio: get('payoutRatioTTM'),
    revenueGrowthYoy: get('revenueGrowthTTMYoy'),
    revenueGrowth5y: get('revenueGrowth5Y'),
    epsGrowthYoy: get('epsGrowthTTMYoy'),
    epsGrowth5y: get('epsGrowth5Y'),
    sharesOutstanding: null,
    marketCapUsd: mcapUsd,
    beta: get('beta'),
    avgVolume30d: liquidity.avgVolume30d,
    avgDollarVolume30d: liquidity.avgDollarVolume30d,
    source: basics ? 'finnhub' : 'computed',
  };
}

// ---------------------------------------------------------------------------
// Canadian (yfinance) builders
// ---------------------------------------------------------------------------

/**
 * Build FundamentalsSnapshot rows from Yahoo quarterly statements. Yahoo gives
 * us up to 4 recent quarters; each maps to a periodType 'Q' row. We only have
 * the subset of concepts Yahoo's quarterly modules expose (no cash-flow split),
 * so the cash-flow columns stay null — the discovery scorer doesn't read them
 * for CA names.
 */
function buildCaSnapshotRows(ticker: string, f: YFinanceFundamentals): SnapshotRow[] {
  return f.quarters.map((q) => ({
    ticker,
    periodEnd: q.periodEnd,
    periodType: 'Q',
    reportedAt: null,
    revenue: toDecimal(q.revenue),
    costOfRevenue: null,
    grossProfit: null,
    operatingIncome: null,
    netIncome: toDecimal(q.netIncome),
    epsBasic: null,
    epsDiluted: toDecimal(q.epsDiluted),
    totalAssets: toDecimal(q.totalAssets),
    totalLiabilities: toDecimal(q.totalLiabilities),
    longTermDebt: null,
    shortTermDebt: null,
    totalEquity: toDecimal(q.totalEquity),
    cash: toDecimal(q.cash),
    operatingCashFlow: null,
    freeCashFlow: null,
    capex: null,
    sharesOutstanding: null,
    source: 'yfinance',
  }));
}

/**
 * Map YFinanceFundamentals to a TickerMetrics row, normalizing units to match
 * the US (Finnhub) path so the discovery scorer treats CA + US rows identically:
 *   - Yahoo margins / ROE / ROA / growth / dividend yield are decimals
 *     (0.31 = 31%); Finnhub stores these as percents (31), so we ×100.
 *   - debtToEquity is already normalized to a ratio in the adapter.
 *   - marketCap is reported in CAD; convert to USD via the provided fx rate.
 */
function buildCaMetricsData(
  ticker: string,
  f: YFinanceFundamentals,
  liquidity: LiquidityResult,
  usdCadRate: number,
): MetricsData {
  const pct = (v: number | null): number | null => (v === null ? null : v * 100);

  let marketCapUsd: Prisma.Decimal | null = null;
  if (f.marketCapRaw !== null) {
    const usd =
      Number.isFinite(usdCadRate) && usdCadRate > 0 ? f.marketCapRaw / usdCadRate : f.marketCapRaw;
    marketCapUsd = toDecimal(usd);
  }

  return {
    ticker,
    fetchedAt: new Date(),
    peTtm: f.peTtm,
    pegTtm: f.pegTtm,
    psTtm: f.psTtm,
    pbTtm: f.pbTtm,
    evToEbitda: f.evToEbitda,
    roeTtm: pct(f.roeTtm),
    // Yahoo has no ROIC; leave null (scorer averages over present signals).
    roicTtm: null,
    roaTtm: pct(f.roaTtm),
    grossMarginTtm: pct(f.grossMarginTtm),
    operatingMarginTtm: pct(f.operatingMarginTtm),
    netMarginTtm: pct(f.netMarginTtm),
    debtToEquity: f.debtToEquity,
    currentRatio: f.currentRatio,
    quickRatio: f.quickRatio,
    dividendYieldTtm: pct(f.dividendYieldTtm),
    dividendPayoutRatio: pct(f.payoutRatio),
    revenueGrowthYoy: pct(f.revenueGrowthYoy),
    // Yahoo's quoteSummary doesn't carry 5y CAGRs; leave null.
    revenueGrowth5y: null,
    epsGrowthYoy: pct(f.epsGrowthYoy),
    epsGrowth5y: null,
    sharesOutstanding: toDecimal(f.sharesOutstanding),
    marketCapUsd,
    beta: f.beta,
    avgVolume30d: liquidity.avgVolume30d,
    avgDollarVolume30d: liquidity.avgDollarVolume30d,
    source: 'yfinance',
  };
}
