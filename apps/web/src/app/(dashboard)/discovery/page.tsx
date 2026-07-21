/**
 * /discovery - Phase 15 market discovery table.
 *
 * Server component: pulls the latest DiscoveryScore batch (top candidates by score),
 * joins with TickerUniverse for name/sector, and annotates held/watchlist
 * badges. Client component below handles filtering, lens ranking + row actions.
 */

import * as React from 'react';
import {
  prisma,
  EventKind,
  type DiscoveryScore,
  type MarketEvent,
  type TickerUniverse,
  type TickerMetrics,
  type Watchlist,
  type Position,
} from '@vantage/db';
import {
  CURATED_POOL,
  incomeRiskFloorForSecurity,
  type CuratedSecurity,
} from '@vantage/core/goals';
import { MONTHLY_INCOME_TICKERS, monthlyIncomeFallback } from '@vantage/core/goals/monthly-income';
import { exchangeFromSymbol, resolveListingCurrency } from '@vantage/sources';
import { FrostedPanel } from '@/components/FrostedPanel';
import { DiscoveryTable, type DiscoveryRow } from './DiscoveryTable';
import { ResearchTabs } from '@/components/ResearchTabs';
import { renderMarketEvent } from '@/lib/chatRetrieval';
import { resolveIncomeYieldEstimate } from '@/lib/discoveryLens';
import { DbErrorBanner } from '@/components/DbErrorBanner';

export const dynamic = 'force-dynamic';

const CURATED_INCOME_BY_TICKER = new Map<string, CuratedSecurity>(
  CURATED_POOL.filter((security) => MONTHLY_INCOME_TICKERS.has(security.ticker.toUpperCase())).map(
    (security) => [security.ticker.toUpperCase(), security],
  ),
);

const MONTHLY_INCOME_TICKER_LIST = Array.from(MONTHLY_INCOME_TICKERS);

async function loadRows(): Promise<DiscoveryRow[]> {
  // Latest computedAt cohort (single batch).
  const latest = await prisma.discoveryScore.aggregate({
    _max: { computedAt: true },
  });
  const computedAt = latest._max.computedAt;

  // Fetch held + watchlisted first so every candidate can carry its status.
  const [positions, watchlist] = await Promise.all([
    prisma.position.findMany({
      where: { closedAt: null },
      select: { ticker: true },
    }) as Promise<Array<Pick<Position, 'ticker'>>>,
    prisma.watchlist.findMany({
      select: { ticker: true },
    }) as Promise<Array<Pick<Watchlist, 'ticker'>>>,
  ]);
  let topScores: DiscoveryScore[] = [];
  let monthlyIncomeScores: DiscoveryScore[] = [];
  if (computedAt) {
    [topScores, monthlyIncomeScores] = (await Promise.all([
      prisma.discoveryScore.findMany({
        where: { computedAt },
        orderBy: { score: 'desc' },
        // Pull a wider candidate set so the client-side Growth/Income/Catalyst
        // lenses can re-rank beyond the old generic-quality top 50.
        take: 1000,
      }),
      prisma.discoveryScore.findMany({
        where: {
          computedAt,
          ticker: { in: MONTHLY_INCOME_TICKER_LIST },
        },
        orderBy: { score: 'desc' },
      }),
    ])) as [DiscoveryScore[], DiscoveryScore[]];
  }

  const scoreMap = new Map<string, DiscoveryScore>();
  for (const score of [...topScores, ...monthlyIncomeScores]) {
    scoreMap.set(score.ticker.toUpperCase(), score);
  }
  const scores = [...scoreMap.values()].sort((a, b) => b.score - a.score);
  const tickers = Array.from(
    new Set([...scores.map((s) => s.ticker.toUpperCase()), ...MONTHLY_INCOME_TICKER_LIST]),
  );
  if (tickers.length === 0) return [];

  const [universe, metrics] = await Promise.all([
    prisma.tickerUniverse.findMany({
      where: { symbol: { in: tickers } },
      select: {
        symbol: true,
        name: true,
        sector: true,
        marketCapUsd: true,
        category: true,
        exchange: true,
        currency: true,
      },
    }) as Promise<
      Array<
        Pick<
          TickerUniverse,
          'symbol' | 'name' | 'sector' | 'marketCapUsd' | 'category' | 'exchange' | 'currency'
        >
      >
    >,
    prisma.tickerMetrics.findMany({
      where: { ticker: { in: tickers } },
      select: {
        ticker: true,
        dividendYieldTtm: true,
        dividendPayoutRatio: true,
        revenueGrowthYoy: true,
        epsGrowthYoy: true,
        peTtm: true,
        beta: true,
      },
    }) as Promise<
      Array<
        Pick<
          TickerMetrics,
          | 'ticker'
          | 'dividendYieldTtm'
          | 'dividendPayoutRatio'
          | 'revenueGrowthYoy'
          | 'epsGrowthYoy'
          | 'peTtm'
          | 'beta'
        >
      >
    >,
  ]);

  const universeMap = new Map<
    string,
    {
      name: string;
      sector: string | null;
      marketCapUsd: number | null;
      category: string | null;
      exchange: string;
      currency: 'USD' | 'CAD';
    }
  >();
  for (const u of universe) {
    universeMap.set(u.symbol.toUpperCase(), {
      name: u.name,
      sector: u.sector,
      marketCapUsd:
        u.marketCapUsd === null || u.marketCapUsd === undefined ? null : Number(u.marketCapUsd),
      category: u.category ?? null,
      exchange: u.exchange,
      currency: u.currency === 'CAD' ? 'CAD' : 'USD',
    });
  }
  const metricsMap = new Map<
    string,
    {
      dividendYieldTtm: number | null;
      dividendPayoutRatio: number | null;
      revenueGrowthYoy: number | null;
      epsGrowthYoy: number | null;
      peTtm: number | null;
      beta: number | null;
    }
  >();
  for (const m of metrics) {
    metricsMap.set(m.ticker.toUpperCase(), {
      dividendYieldTtm: m.dividendYieldTtm ?? null,
      dividendPayoutRatio: m.dividendPayoutRatio ?? null,
      revenueGrowthYoy: m.revenueGrowthYoy ?? null,
      epsGrowthYoy: m.epsGrowthYoy ?? null,
      peTtm: m.peTtm ?? null,
      beta: m.beta ?? null,
    });
  }
  const heldSet = new Set(positions.map((p) => p.ticker.toUpperCase()));
  const watchSet = new Set(watchlist.map((w) => w.ticker.toUpperCase()));

  // Phase 17.9 - pull most-recent catalyst MarketEvent (last 30d) per
  // ticker. We use a single ticker-IN query and bucket client-side by ticker
  // so each row gets its newest event without an N+1.
  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const catalystEvents = (await prisma.marketEvent.findMany({
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
    select: { ticker: true, kind: true, occurredAt: true, payload: true },
  })) as Array<Pick<MarketEvent, 'ticker' | 'kind' | 'occurredAt' | 'payload'>>;
  const catalystByTicker = new Map<
    string,
    { kind: string; occurredAt: string; details: string[] }
  >();
  for (const ev of catalystEvents) {
    if (!ev.ticker) continue;
    const k = ev.ticker.toUpperCase();
    if (catalystByTicker.has(k)) continue;
    catalystByTicker.set(k, {
      kind: String(ev.kind),
      occurredAt: ev.occurredAt.toISOString(),
      details: renderMarketEvent(ev).map((line) => line.replace(/^\d{4}-\d{2}-\d{2}\s+/, '')),
    });
  }

  const rows: DiscoveryRow[] = tickers
    .filter(
      (ticker) =>
        scoreMap.has(ticker) || universeMap.has(ticker) || CURATED_INCOME_BY_TICKER.has(ticker),
    )
    .map((ticker) => {
      const s = scoreMap.get(ticker);
      const meta = universeMap.get(ticker);
      const curated = CURATED_INCOME_BY_TICKER.get(ticker) ?? null;
      const breakdown = (s?.signalBreakdown ?? null) as Record<string, unknown> | null;
      const catalyst = catalystByTicker.get(ticker) ?? null;
      const m = metricsMap.get(ticker) ?? null;
      const liveYield = m?.dividendYieldTtm ?? null;
      const curatedYield = curated?.expectedYield ?? null;
      const fallback = monthlyIncomeFallback(ticker);
      const fallbackYield = fallback?.expectedYield ?? null;
      const incomeYield = resolveIncomeYieldEstimate(liveYield, curatedYield ?? fallbackYield);
      const suffixExchange = exchangeFromSymbol(ticker);
      const inferredExchange = suffixExchange !== 'US' ? suffixExchange : (meta?.exchange ?? 'US');
      const inferredCurrency = resolveListingCurrency(ticker, meta?.currency, meta?.exchange);
      return {
        ticker,
        name: meta?.name ?? curated?.name ?? '-',
        sector: meta?.sector ?? (curated ? sectorForCuratedSecurity(curated) : null),
        marketCapUsd: meta?.marketCapUsd ?? null,
        category: curated?.category ?? meta?.category ?? null,
        exchange: curated ? exchangeForCuratedSecurity(ticker, curated) : inferredExchange,
        currency: curated?.currency ?? inferredCurrency,
        score: s?.score ?? 0,
        scoreAvailable: s !== undefined,
        breakdown: breakdown ? normalizeBreakdown(breakdown) : null,
        curatedIncome: curated !== null,
        incomeCadence: curated || fallbackYield !== null ? 'monthly' : null,
        incomeRiskFloor: curated
          ? incomeRiskFloorForSecurity(curated)
          : (fallback?.riskFloor ?? 'aggressive'),
        incomeYieldEstimate: incomeYield.estimate,
        incomeYieldSource: incomeYield.source,
        metrics: m,
        computedAt: s?.computedAt.toISOString() ?? null,
        held: heldSet.has(ticker),
        watchlisted: watchSet.has(ticker),
        catalyst,
      };
    });
  return rows;
}

function exchangeForCuratedSecurity(ticker: string, security: CuratedSecurity): string {
  if (ticker.endsWith('.TO')) return 'TSX';
  if (ticker.endsWith('.NE')) return 'NE';
  if (ticker.endsWith('.V')) return 'V';
  return security.currency === 'CAD' ? 'TSX' : 'US';
}

function sectorForCuratedSecurity(security: CuratedSecurity): string {
  if (security.category === 'REIT') return 'REIT';
  if (security.category === 'IndividualStock') return 'Stock';
  return 'ETF';
}

function normalizeBreakdown(raw: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of [
    'epsGrowth',
    'revenueGrowth',
    'margins',
    'valuation',
    'profitability',
    'balanceSheet',
    'liquidity',
    'size',
    'momentum',
    'news',
    'earnings',
    'insider',
    'filings',
    'sentiment',
  ]) {
    const v = raw[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

export default async function DiscoveryPage(): Promise<React.ReactElement> {
  let rows: DiscoveryRow[] = [];
  let dbError: string | null = null;
  try {
    rows = await loadRows();
  } catch (err) {
    dbError = err instanceof Error ? err.message : 'database unreachable';
  }

  const sectors = Array.from(
    new Set(rows.map((r) => r.sector).filter((s): s is string => Boolean(s))),
  ).sort();

  return (
    <div className="cc-page">
      <header className="mb-6">
        <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
          discovery
        </div>
        <h1 className="cc-page-title">Market surface</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Find ideas by purpose and risk: growth, monthly income, catalyst momentum, or
          quality/value. Raw score is still available.
        </p>
      </header>

      <div className="mb-6">
        <ResearchTabs />
      </div>

      <DbErrorBanner message={dbError} />

      <FrostedPanel padding="none" className="overflow-hidden">
        {rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-16 text-center">
            <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
              No scores yet.
            </div>
            <p className="max-w-md text-sm text-muted-foreground">
              Discovery runs nightly at 6pm ET. Trigger a recompute from{' '}
              <a
                href="/settings"
                className="text-[var(--cc-accent)] underline-offset-2 hover:underline"
              >
                settings
              </a>{' '}
              to populate the table.
            </p>
          </div>
        ) : (
          <DiscoveryTable rows={rows} sectors={sectors} />
        )}
      </FrostedPanel>
    </div>
  );
}
