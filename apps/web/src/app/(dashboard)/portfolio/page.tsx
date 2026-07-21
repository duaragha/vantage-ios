/**
 * /portfolio — main holdings view.
 *
 * Server component. Fetches open positions + their theses + live prices,
 * composes a summary row + a frosted-glass table.
 */

import * as React from 'react';
import Link from 'next/link';
import {
  findThesisByPositionId,
  getSettings,
  listOpenPositions,
  prisma,
  type Position,
  type Thesis,
} from '@vantage/db';
import { getUsdCadRate } from '@vantage/core/fx';
import { aggregatePositionsByTicker } from '@vantage/core/portfolio';
import {
  exchangeFlag,
  exchangeFromSymbol,
  isCaExchange,
  resolveListingCurrency,
} from '@vantage/sources';
import { fetchLivePrices, type LivePrice } from '@/lib/prices';
import { FrostedPanel } from '@/components/FrostedPanel';
import { ThesisStrip, ThesisLabel, type ThesisHealth } from '@/components/ThesisGlow';
import { StatusDot } from '@/components/StatusDot';
import { AccountBadge } from '@/components/AccountBadge';
import { PortfolioTabs } from '@/components/PortfolioTabs';
import { fmtMoney, fmtPct, fmtShares, fmtTimeAgo, pnlTone } from '@/lib/format';
import { cn } from '@/lib/utils';
import { listAccounts, type AccountListItem } from '@/app/(dashboard)/accounts/data';
import { AddPositionButton } from './AddPositionButton';
import { AccountFilter } from './AccountFilter';
import { CurrencyToggle } from './CurrencyToggle';
import { SectorDonut } from './SectorDonut';
import { DbErrorBanner } from '@/components/DbErrorBanner';

/** Signed money in a given display currency (e.g. "+C$1,234.00" / "-$50.00"). */
function fmtMoneySigned(n: number | null | undefined, currency: 'USD' | 'CAD'): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  return `${sign}${fmtMoney(Math.abs(n), currency)}`;
}

export const dynamic = 'force-dynamic';

interface Row {
  position: Position;
  thesis: Thesis | null;
  price: LivePrice | null;
  health: ThesisHealth;
  /**
   * Listing exchange code from TickerUniverse — US, TO, NE, V. Defaults to
   * 'US' when the universe row is missing.
   */
  exchange: string;
  /**
   * Native currency avgCost + price are denominated in. Sourced from
   * Position.currency (the stored cost currency), falling back to the listing
   * currency from TickerUniverse when the position predates the column.
   */
  currency: 'USD' | 'CAD';
  /** Value in the position's native currency — shares × price. */
  nativeValue: number;
  /** Cost basis in native currency. */
  nativeCostBasis: number;
  /** Value in the chosen DISPLAY currency (post-FX conversion). */
  currentValue: number;
  /** Cost basis in the chosen DISPLAY currency. */
  costBasis: number;
  /** P&L in the chosen DISPLAY currency. */
  pnlUsd: number;
  pnlPct: number;
  /** Account this position lives in (null when accounts data is unavailable). */
  account: { id: number; name: string; type: string } | null;
}

interface CombinedRow {
  ticker: string;
  rows: Row[];
  totalShares: number;
  weightedAvgCost: number;
  currency: 'USD' | 'CAD';
  exchange: string;
  currentValue: number;
  costBasis: number;
  pnl: number;
  pnlPct: number;
  health: ThesisHealth;
  sector: string | null;
}

const HEALTH_PRIORITY: Record<ThesisHealth, number> = {
  Broken: 6,
  Weakening: 5,
  Stale: 4,
  None: 3,
  Intact: 2,
  Strengthening: 1,
};

function buildCombinedRows(rows: Row[]): CombinedRow[] {
  const byTicker = new Map<string, Row[]>();
  for (const row of rows) {
    const ticker = row.position.ticker.toUpperCase();
    const bucket = byTicker.get(ticker) ?? [];
    bucket.push(row);
    byTicker.set(ticker, bucket);
  }

  const aggregates = aggregatePositionsByTicker(
    rows.map((row) => ({
      ticker: row.position.ticker.toUpperCase(),
      shares: Number(row.position.shares),
      avgCost: Number(row.position.avgCost),
      account: {
        id: row.account?.id ?? row.position.accountId,
        type: row.account?.type ?? 'Unknown',
      },
    })),
  );

  return aggregates.map((aggregate) => {
    const lots = byTicker.get(aggregate.ticker) ?? [];
    const representative = lots[0]!;
    const currentValue = lots.reduce((sum, row) => sum + row.currentValue, 0);
    const costBasis = lots.reduce((sum, row) => sum + row.costBasis, 0);
    const health = lots.reduce(
      (worst, row) => (HEALTH_PRIORITY[row.health] > HEALTH_PRIORITY[worst] ? row.health : worst),
      representative.health,
    );
    return {
      ticker: aggregate.ticker,
      rows: lots,
      totalShares: aggregate.totalShares,
      weightedAvgCost: aggregate.weightedAvgCost,
      currency: representative.currency,
      exchange: representative.exchange,
      currentValue,
      costBasis,
      pnl: currentValue - costBasis,
      pnlPct: costBasis > 0 ? ((currentValue - costBasis) / costBasis) * 100 : 0,
      health,
      sector: representative.position.sector,
    };
  });
}

/**
 * Convert `amount` from `from` currency to `to` (display) currency.
 * `usdCadRate` is CAD per 1 USD. Same-currency passes through.
 */
function convertCurrency(
  amount: number,
  from: 'USD' | 'CAD',
  to: 'USD' | 'CAD',
  usdCadRate: number,
): number {
  if (from === to) return amount;
  if (from === 'USD') return amount * usdCadRate;
  return usdCadRate > 0 ? amount / usdCadRate : amount;
}

function resolveHealth(thesis: Thesis | null): ThesisHealth {
  if (!thesis) return 'None';
  const staleCutoffDays = 30;
  const days = (Date.now() - thesis.lastValidatedAt.getTime()) / (1000 * 60 * 60 * 24);
  if (days > staleCutoffDays) return 'Stale';
  return thesis.status as ThesisHealth;
}

async function loadRows(
  accounts: AccountListItem[],
  displayCurrency: 'USD' | 'CAD',
): Promise<Row[]> {
  const positions = await listOpenPositions();
  if (positions.length === 0) return [];
  const accountById = new Map(
    accounts.map((a) => [a.id, { id: a.id, name: a.name, type: a.type as string }]),
  );
  const theses = await Promise.all(positions.map((p) => findThesisByPositionId(p.id)));
  const priceMap = await fetchLivePrices(positions.map((p) => p.ticker));
  // Phase 16 — look up each position in TickerUniverse to get its exchange (for
  // the badge) + listing currency (a fallback when the position has no stored
  // currency). We only pay for this once per page render.
  const universeRows = await prisma.tickerUniverse.findMany({
    where: { symbol: { in: positions.map((p) => p.ticker.toUpperCase()) } },
    select: { symbol: true, exchange: true, currency: true },
  });
  const universeMap = new Map<string, { exchange: string; currency: 'USD' | 'CAD' }>();
  for (const u of universeRows) {
    universeMap.set(u.symbol.toUpperCase(), {
      exchange: u.exchange,
      currency: u.currency === 'CAD' ? 'CAD' : 'USD',
    });
  }
  // Pull FX rate once — conversion is sync per row.
  const rate = await getUsdCadRate();

  return positions.map((position, i) => {
    const thesis = theses[i] ?? null;
    const price = priceMap[position.ticker.toUpperCase()] ?? null;
    const shares = Number(position.shares);
    const avgCost = Number(position.avgCost);
    const meta = universeMap.get(position.ticker.toUpperCase());
    const suffixExchange = exchangeFromSymbol(position.ticker);
    const exchange = suffixExchange !== 'US' ? suffixExchange : (meta?.exchange ?? 'US');
    // Native currency: the position's stored cost currency wins; fall back to
    // the listing currency from TickerUniverse for pre-migration rows.
    const storedCurrency = (position as Position & { currency?: string | null }).currency;
    const currency = resolveListingCurrency(
      position.ticker,
      storedCurrency ?? meta?.currency,
      meta?.exchange,
    );
    const nativeValue = price ? shares * price.price : shares * avgCost;
    const nativeCostBasis = shares * avgCost;
    const currentValue = convertCurrency(nativeValue, currency, displayCurrency, rate);
    const costBasis = convertCurrency(nativeCostBasis, currency, displayCurrency, rate);
    const pnlUsd = currentValue - costBasis;
    const pnlPct = costBasis > 0 ? (pnlUsd / costBasis) * 100 : 0;
    // The Position type now carries accountId post-migration; cast through
    // until the upstream `Position` re-export from @vantage/db reflects
    // it at the type level.
    const accountId = (position as Position & { accountId?: number | null }).accountId ?? null;
    const account = accountId !== null ? (accountById.get(accountId) ?? null) : null;
    return {
      position,
      thesis,
      price,
      health: resolveHealth(thesis),
      exchange,
      currency,
      nativeValue,
      nativeCostBasis,
      currentValue,
      costBasis,
      pnlUsd,
      pnlPct,
      account,
    };
  });
}

interface PortfolioPageProps {
  searchParams: Promise<{ accountId?: string; ccy?: string; view?: string }>;
}

export default async function PortfolioPage({
  searchParams,
}: PortfolioPageProps): Promise<React.ReactElement> {
  const sp = await searchParams;
  // accountId param: numeric → only that account; 'archived' → only archived
  // accounts (sentinel filter); absent → all open positions across all
  // non-archived accounts.
  const accountFilter: number | 'archived' | null = (() => {
    const v = sp.accountId;
    if (!v) return null;
    if (v === 'archived') return 'archived';
    if (/^\d+$/.test(v)) return Number(v);
    return null;
  })();

  // Display currency — flips every dollar value on the page. Default CAD (the
  // user is Canadian). `?ccy=USD` switches the whole view to USD.
  const displayCurrency: 'USD' | 'CAD' = sp.ccy?.toUpperCase() === 'USD' ? 'USD' : 'CAD';
  const holdingsView: 'combined' | 'lots' = sp.view === 'lots' ? 'lots' : 'combined';

  let allRows: Row[] = [];
  let accounts: AccountListItem[] = [];
  let settings: Awaited<ReturnType<typeof getSettings>> = null;
  let dbError: string | null = null;
  try {
    accounts = await listAccounts({ includeArchived: true });
    [allRows, settings] = await Promise.all([loadRows(accounts, displayCurrency), getSettings()]);
  } catch (err) {
    dbError = err instanceof Error ? err.message : 'database unreachable';
  }

  const archivedAccountIds = new Set(
    accounts.filter((a) => a.archivedAt !== null).map((a) => a.id),
  );
  const rows = allRows.filter((r) => {
    if (accountFilter === null) {
      // Default view: hide positions that live in archived accounts.
      return r.account === null || !archivedAccountIds.has(r.account.id);
    }
    if (accountFilter === 'archived') {
      return r.account !== null && archivedAccountIds.has(r.account.id);
    }
    return r.account?.id === accountFilter;
  });

  const totalValue = rows.reduce((s, r) => s + r.currentValue, 0);
  const totalCost = rows.reduce((s, r) => s + r.costBasis, 0);
  const totalPnl = totalValue - totalCost;
  const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;
  // Today P&L needs the same FX treatment. Fetch the rate once (cached in the
  // fx helper) and convert each native delta into the display currency.
  const rateForTotals = rows.some((r) => r.currency !== displayCurrency)
    ? await getUsdCadRate()
    : 1;
  const todaysPnl = rows.reduce((s, r) => {
    if (!r.price) return s;
    const deltaNative = (r.price.price - r.price.previousClose) * Number(r.position.shares);
    return s + convertCurrency(deltaNative, r.currency, displayCurrency, rateForTotals);
  }, 0);

  // UserSettings.monthlyBudget is the USD cap enforced by the allocation engines.
  const monthlyBudgetUsd = settings ? Number(settings.monthlyBudget) : 0;
  const monthlyBudget = convertCurrency(
    monthlyBudgetUsd,
    'USD',
    displayCurrency,
    rateForTotals === 1 && displayCurrency !== 'USD' ? await getUsdCadRate() : rateForTotals,
  );
  const combinedRows = buildCombinedRows(rows);
  const largestPct = combinedRows.length
    ? Math.max(
        ...combinedRows.map((row) => (totalValue > 0 ? (row.currentValue / totalValue) * 100 : 0)),
      )
    : 0;

  const sectorBreakdown = (() => {
    const bucket = new Map<string, number>();
    for (const r of rows) {
      const key = r.position.sector ?? 'Unclassified';
      bucket.set(key, (bucket.get(key) ?? 0) + r.currentValue);
    }
    return [...bucket.entries()]
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
  })();

  // Per-account aggregation feeds the "Total by account" sidebar. Computed
  // against the filtered `rows` so when the user filters to one account, this
  // panel collapses to a single line + 100% weight.
  const accountTotals = (() => {
    const bucket = new Map<number, { name: string; type: string; value: number }>();
    for (const r of rows) {
      if (!r.account) continue;
      const cur = bucket.get(r.account.id);
      bucket.set(r.account.id, {
        name: r.account.name,
        type: r.account.type,
        value: (cur?.value ?? 0) + r.currentValue,
      });
    }
    return [...bucket.entries()].map(([id, b]) => ({ id, ...b })).sort((a, b) => b.value - a.value);
  })();

  const viewHref = (view: 'combined' | 'lots') => {
    const params = new URLSearchParams();
    if (sp.accountId) params.set('accountId', sp.accountId);
    if (displayCurrency === 'USD') params.set('ccy', 'USD');
    params.set('view', view);
    return `/portfolio?${params.toString()}`;
  };

  return (
    <div className="cc-page min-w-0">
      <header className="cc-page-header min-w-0">
        <div>
          <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
            <StatusDot status="fresh" />
            portfolio
          </div>
          <h1 className="cc-page-title">Holdings</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {rows.length === 0
              ? 'Nothing here yet. Add a position to get started.'
              : `${combinedRows.length} securit${combinedRows.length === 1 ? 'y' : 'ies'} across ${rows.length} account lot${rows.length === 1 ? '' : 's'}.`}
          </p>
        </div>
        <div className="cc-page-actions grid min-w-0 grid-cols-2 md:flex">
          <div className="col-span-2 flex min-w-0 items-center gap-2 md:contents">
            <div className="shrink-0 [&>div]:min-h-11 [&>div]:justify-center [&_button]:min-h-11">
              <CurrencyToggle displayCurrency={displayCurrency} accountFilter={accountFilter} />
            </div>
            <div className="min-w-0 flex-1 [&>label]:min-w-0 [&>label]:justify-end [&_select]:min-h-11 [&_select]:min-w-0 [&_select]:max-w-full">
              <AccountFilter accounts={accounts} selectedId={accountFilter} />
            </div>
          </div>
          <Link
            href="/portfolio/import"
            className="inline-flex min-h-11 min-w-0 items-center justify-center rounded-md border border-white/[0.08] px-3 py-2 text-center font-mono text-xs uppercase tracking-[0.16em] text-muted-foreground transition hover:border-white/[0.2] hover:text-foreground md:tracking-[0.2em]"
          >
            Bulk import
          </Link>
          <div className="min-w-0 [&>button]:min-h-11 [&>button]:w-full [&>button]:justify-center">
            <AddPositionButton accounts={accounts.filter((a) => a.archivedAt === null)} />
          </div>
        </div>
      </header>

      <div className="mb-6 flex items-center justify-between gap-4 [&_a]:min-h-11">
        <PortfolioTabs />
        <div className="flex shrink-0 rounded-md border border-white/[0.08] p-0.5 font-mono text-[10px] uppercase">
          <Link
            href={viewHref('combined')}
            aria-current={holdingsView === 'combined' ? 'page' : undefined}
            className={cn(
              'inline-flex min-h-8 items-center rounded px-2.5 transition',
              holdingsView === 'combined'
                ? 'bg-[var(--cc-accent)]/10 text-[var(--cc-accent)]'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            Combined
          </Link>
          <Link
            href={viewHref('lots')}
            aria-current={holdingsView === 'lots' ? 'page' : undefined}
            className={cn(
              'inline-flex min-h-8 items-center rounded px-2.5 transition',
              holdingsView === 'lots'
                ? 'bg-[var(--cc-accent)]/10 text-[var(--cc-accent)]'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            Account lots
          </Link>
        </div>
      </div>

      <DbErrorBanner message={dbError} />

      {rows.some((r) => r.exchange === 'NE' || r.exchange === 'V') && (
        <div className="mb-6 rounded-md border border-amber-500/30 bg-amber-500/[0.05] px-4 py-2.5 text-xs text-amber-200/90">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-amber-300/80">
            Wealthsimple heads-up
          </span>
          <span className="ml-2">
            Holdings tagged <span className="font-mono">NE</span> or{' '}
            <span className="font-mono">V</span> trade on NEO / TSX-V. Check liquidity on
            Wealthsimple before executing — spreads can be wide.
          </span>
        </div>
      )}

      {/* Summary cards */}
      <section className="mb-6 grid min-w-0 grid-cols-2 gap-3 [&>*:last-child]:col-span-2 md:grid-cols-5 md:gap-4 md:[&>*:last-child]:col-span-1">
        <SummaryCard
          label="Total value"
          value={fmtMoney(totalValue, displayCurrency)}
          tone="neutral"
        />
        <SummaryCard
          label="Today P&L"
          value={fmtMoneySigned(todaysPnl, displayCurrency)}
          tone={todaysPnl === 0 ? 'neutral' : todaysPnl > 0 ? 'good' : 'bad'}
        />
        <SummaryCard
          label="Total P&L"
          value={`${fmtMoneySigned(totalPnl, displayCurrency)} / ${fmtPct(totalPnlPct)}`}
          tone={totalPnl === 0 ? 'neutral' : totalPnl > 0 ? 'good' : 'bad'}
        />
        <SummaryCard label="Monthly budget" value={fmtMoney(monthlyBudget, displayCurrency)} />
        <SummaryCard
          label="Concentration"
          value={fmtPct(largestPct)}
          tone={largestPct > (settings?.singlePositionCapPct ?? 15) ? 'warn' : 'neutral'}
          subtle={settings ? `cap ${settings.singlePositionCapPct.toFixed(0)}%` : undefined}
        />
      </section>

      <section className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
        <FrostedPanel padding="none" className="min-w-0 overflow-hidden">
          {rows.length === 0 ? (
            <EmptyState />
          ) : (
            <>
              <div className="divide-y divide-white/[0.06] md:hidden">
                {holdingsView === 'combined'
                  ? combinedRows.map((row) => (
                      <CombinedPortfolioMobileCard
                        key={row.ticker}
                        row={row}
                        displayCurrency={displayCurrency}
                      />
                    ))
                  : rows.map((row) => (
                      <PortfolioMobileCard
                        key={row.position.id}
                        row={row}
                        displayCurrency={displayCurrency}
                      />
                    ))}
              </div>
              <div className="hidden overflow-x-auto md:block">
                {holdingsView === 'combined' ? (
                  <CombinedPortfolioTable rows={combinedRows} displayCurrency={displayCurrency} />
                ) : (
                  <table className="w-full min-w-[1050px] text-sm">
                    <thead>
                      <tr className="border-b border-white/[0.06] text-left font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                        <Th>Ticker</Th>
                        <Th>Account</Th>
                        <Th className="text-right">Shares</Th>
                        <Th className="text-right">Avg cost</Th>
                        <Th className="text-right">Price</Th>
                        <Th className="text-right">Value</Th>
                        <Th className="text-right">P&amp;L $</Th>
                        <Th className="text-right">P&amp;L %</Th>
                        <Th>Thesis</Th>
                        <Th>Sector</Th>
                        <Th>Tag</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <PortfolioRow
                          key={row.position.id}
                          row={row}
                          displayCurrency={displayCurrency}
                        />
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          )}
        </FrostedPanel>

        <div className="flex flex-col gap-4">
          <FrostedPanel className="flex flex-col gap-3" padding="md">
            <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              Total by account
            </div>
            {accountTotals.length === 0 ? (
              <div className="font-mono text-xs text-muted-foreground">Nothing assigned yet.</div>
            ) : (
              <ul className="flex flex-col gap-1.5 font-mono text-xs">
                {accountTotals.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-2">
                    <AccountBadge name={a.name} type={a.type} />
                    <span className="flex items-center gap-2 tabular-nums">
                      <span className="text-foreground/80">
                        {fmtMoney(a.value, displayCurrency)}
                      </span>
                      <span className="text-muted-foreground/70">
                        {totalValue > 0 ? `${((a.value / totalValue) * 100).toFixed(1)}%` : '—'}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </FrostedPanel>

          <FrostedPanel className="flex flex-col gap-3" padding="md">
            <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              Sector exposure
            </div>
            <SectorDonut data={sectorBreakdown} />
            <ul className="mt-2 flex flex-col gap-1.5 font-mono text-xs">
              {sectorBreakdown.length === 0 && (
                <li className="text-muted-foreground">Nothing to slice yet.</li>
              )}
              {sectorBreakdown.map((s, i) => (
                <li key={s.name} className="flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <span
                      className="size-2 rounded-full"
                      style={{ backgroundColor: sliceColor(i) }}
                    />
                    <span className="text-foreground/80">{s.name}</span>
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {totalValue > 0 ? `${((s.value / totalValue) * 100).toFixed(1)}%` : '—'}
                  </span>
                </li>
              ))}
            </ul>
          </FrostedPanel>
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Th({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <th className={cn('px-4 py-3 font-medium text-muted-foreground', className)}>{children}</th>
  );
}

function CombinedPortfolioTable({
  rows,
  displayCurrency,
}: {
  rows: CombinedRow[];
  displayCurrency: 'USD' | 'CAD';
}): React.ReactElement {
  return (
    <table className="w-full min-w-[930px] text-sm">
      <thead>
        <tr className="border-b border-white/[0.06] text-left font-mono text-[10px] uppercase text-muted-foreground">
          <Th>Ticker</Th>
          <Th>Accounts</Th>
          <Th className="text-right">Total shares</Th>
          <Th className="text-right">Blended cost</Th>
          <Th className="text-right">Price</Th>
          <Th className="text-right">Value</Th>
          <Th className="text-right">P&amp;L</Th>
          <Th>Thesis</Th>
          <Th>Sector</Th>
          <Th className="text-right">Lots</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const representative = row.rows[0]!;
          const flag = exchangeFlag(row.exchange);
          const fresh =
            representative.price &&
            Date.now() - representative.price.fetchedAt.getTime() < 5 * 60 * 1000;
          const accounts = row.rows
            .map((lot) => lot.account?.name)
            .filter((name): name is string => Boolean(name));
          return (
            <tr key={row.ticker} className="border-b border-white/[0.04] hover:bg-white/[0.02]">
              <td className="px-4 py-3">
                <Link
                  href={`/positions/${row.ticker}`}
                  className="inline-flex items-center gap-2 font-mono text-sm font-semibold"
                >
                  <span className="text-[11px]" aria-hidden>
                    {flag}
                  </span>
                  {row.ticker}
                </Link>
              </td>
              <td className="max-w-[24ch] px-4 py-3 text-xs text-muted-foreground">
                {accounts.join(', ') || '-'}
              </td>
              <td className="px-4 py-3 text-right font-mono tabular-nums">
                {fmtShares(row.totalShares)}
              </td>
              <td className="px-4 py-3 text-right font-mono tabular-nums text-muted-foreground">
                {fmtMoney(row.weightedAvgCost, row.currency)}
              </td>
              <td className="px-4 py-3 text-right font-mono tabular-nums">
                <span className="inline-flex items-center gap-2">
                  <StatusDot status={fresh ? 'fresh' : 'stale'} />
                  {representative.price ? fmtMoney(representative.price.price, row.currency) : '-'}
                </span>
              </td>
              <td className="px-4 py-3 text-right font-mono tabular-nums">
                {fmtMoney(row.currentValue, displayCurrency)}
              </td>
              <td className={cn('px-4 py-3 text-right font-mono tabular-nums', pnlTone(row.pnl))}>
                {fmtMoneySigned(row.pnl, displayCurrency)} / {fmtPct(row.pnlPct)}
              </td>
              <td className="px-4 py-3">
                <ThesisLabel status={row.health} />
              </td>
              <td className="px-4 py-3 text-xs text-muted-foreground">{row.sector ?? '-'}</td>
              <td className="px-4 py-3 text-right font-mono tabular-nums text-muted-foreground">
                {row.rows.length}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function CombinedPortfolioMobileCard({
  row,
  displayCurrency,
}: {
  row: CombinedRow;
  displayCurrency: 'USD' | 'CAD';
}): React.ReactElement {
  const accounts = row.rows
    .map((lot) => lot.account?.name)
    .filter((name): name is string => Boolean(name));
  return (
    <article className="px-4 py-4">
      <div className="flex items-start justify-between gap-3">
        <Link href={`/positions/${row.ticker}`} className="font-mono text-base font-semibold">
          {row.ticker}
        </Link>
        <ThesisLabel status={row.health} />
      </div>
      <div className="mt-1 truncate text-xs text-muted-foreground">
        {accounts.join(', ') || 'Account unavailable'}
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-white/[0.06] pt-3">
        <MobilePositionMetric label="Total shares">
          {fmtShares(row.totalShares)}
        </MobilePositionMetric>
        <MobilePositionMetric label="Blended cost">
          {fmtMoney(row.weightedAvgCost, row.currency)}
        </MobilePositionMetric>
        <MobilePositionMetric label="Value">
          {fmtMoney(row.currentValue, displayCurrency)}
        </MobilePositionMetric>
        <MobilePositionMetric label="P&amp;L" className={pnlTone(row.pnl)}>
          {fmtMoneySigned(row.pnl, displayCurrency)} / {fmtPct(row.pnlPct)}
        </MobilePositionMetric>
      </dl>
    </article>
  );
}

function PortfolioRow({
  row,
  displayCurrency,
}: {
  row: Row;
  displayCurrency: 'USD' | 'CAD';
}): React.ReactElement {
  const fresh = row.price && Date.now() - row.price.fetchedAt.getTime() < 5 * 60 * 1000;
  const isCa = isCaExchange(row.exchange);
  const flag = exchangeFlag(row.exchange);
  // Show the native-currency value as a secondary line whenever it differs
  // from the chosen display currency (so a USD-display CAD holding still
  // surfaces its C$ figure, and vice-versa).
  const showNative = row.currency !== displayCurrency;
  return (
    <tr className="group relative border-b border-white/[0.04] transition hover:bg-white/[0.02]">
      <td className="relative px-4 py-3">
        <ThesisStrip status={row.health} />
        <Link
          href={`/positions/${row.position.ticker}?positionId=${row.position.id}`}
          className="flex flex-col gap-0.5"
        >
          <span className="flex items-center gap-1.5 font-mono text-sm font-semibold tracking-wide">
            <span
              title={
                isCa
                  ? `${row.exchange === 'TO' ? 'TSX' : row.exchange === 'V' ? 'TSX-V' : 'NEO'} · reports in CAD`
                  : 'US listing · USD'
              }
              aria-label={`${flag} ${row.exchange}`}
              className={cn(
                'inline-flex items-center rounded-md border px-1.5 py-0 text-[10px]',
                isCa
                  ? 'border-[var(--cc-accent)]/30 bg-[var(--cc-accent)]/5'
                  : 'border-white/10 bg-white/[0.03]',
              )}
            >
              {flag}
            </span>
            {row.position.ticker}
          </span>
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            {row.position.category}
            {isCa && (row.exchange === 'NE' || row.exchange === 'V') ? (
              <span className="ml-2 text-amber-300/80">· thin liq</span>
            ) : null}
          </span>
        </Link>
      </td>
      <td className="px-4 py-3">
        {row.account ? (
          <AccountBadge name={row.account.name} type={row.account.type} />
        ) : (
          <span className="font-mono text-[10px] text-muted-foreground/50">—</span>
        )}
      </td>
      <td className="px-4 py-3 text-right font-mono tabular-nums">
        {fmtShares(Number(row.position.shares))}
      </td>
      <td className="px-4 py-3 text-right font-mono tabular-nums text-muted-foreground">
        {/* Avg cost is always shown in the position's native currency — that's
            the figure the user actually entered. */}
        <div className="flex flex-col items-end">
          <span>{fmtMoney(Number(row.position.avgCost), row.currency)}</span>
          <span className="text-[10px] text-muted-foreground/60">{row.currency}</span>
        </div>
      </td>
      <td className="px-4 py-3 text-right font-mono tabular-nums">
        <div className="flex items-center justify-end gap-2">
          <StatusDot status={fresh ? 'fresh' : 'stale'} />
          {row.price ? fmtMoney(row.price.price, row.currency) : '—'}
        </div>
      </td>
      <td className="px-4 py-3 text-right font-mono tabular-nums">
        <div className="flex flex-col items-end">
          <span>{fmtMoney(row.currentValue, displayCurrency)}</span>
          {showNative && (
            <span className="text-[10px] text-muted-foreground/60">
              {fmtMoney(row.nativeValue, row.currency)} {row.currency}
            </span>
          )}
        </div>
      </td>
      <td className={cn('px-4 py-3 text-right font-mono tabular-nums', pnlTone(row.pnlUsd))}>
        {fmtMoneySigned(row.pnlUsd, displayCurrency)}
      </td>
      <td className={cn('px-4 py-3 text-right font-mono tabular-nums', pnlTone(row.pnlUsd))}>
        {fmtPct(row.pnlPct)}
      </td>
      <td className="px-4 py-3">
        <ThesisLabel status={row.health} />
      </td>
      <td className="px-4 py-3 text-xs text-muted-foreground">{row.position.sector ?? '—'}</td>
      <td className="px-4 py-3 text-xs text-muted-foreground">
        <span className="font-mono">{fmtTimeAgo(row.position.updatedAt)}</span>
      </td>
    </tr>
  );
}

function PortfolioMobileCard({
  row,
  displayCurrency,
}: {
  row: Row;
  displayCurrency: 'USD' | 'CAD';
}): React.ReactElement {
  const fresh = row.price && Date.now() - row.price.fetchedAt.getTime() < 5 * 60 * 1000;
  const isCa = isCaExchange(row.exchange);
  const flag = exchangeFlag(row.exchange);
  const showNative = row.currency !== displayCurrency;

  return (
    <article className="relative min-w-0 overflow-hidden px-4 py-4">
      <ThesisStrip status={row.health} />

      <div className="flex min-w-0 items-start justify-between gap-3">
        <Link
          href={`/positions/${row.position.ticker}?positionId=${row.position.id}`}
          className="flex min-h-11 min-w-0 flex-1 flex-col justify-center gap-0.5 rounded-md outline-none transition hover:text-[var(--cc-accent)] focus-visible:ring-2 focus-visible:ring-[var(--cc-accent)]/60"
        >
          <span className="flex min-w-0 items-center gap-1.5 font-mono text-base font-semibold tracking-wide">
            <span
              title={
                isCa
                  ? `${row.exchange === 'TO' ? 'TSX' : row.exchange === 'V' ? 'TSX-V' : 'NEO'} · reports in CAD`
                  : 'US listing · USD'
              }
              aria-label={`${flag} ${row.exchange}`}
              className={cn(
                'inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 text-[10px]',
                isCa
                  ? 'border-[var(--cc-accent)]/30 bg-[var(--cc-accent)]/5'
                  : 'border-white/10 bg-white/[0.03]',
              )}
            >
              {flag}
            </span>
            <span className="truncate">{row.position.ticker}</span>
          </span>
          <span className="truncate font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            {row.position.category}
            {isCa && (row.exchange === 'NE' || row.exchange === 'V') ? ' · thin liq' : ''}
          </span>
        </Link>
        <ThesisLabel status={row.health} className="mt-1 shrink-0" />
      </div>

      <div className="mt-3 min-w-0">
        <div className="min-w-0">
          {row.account ? (
            <AccountBadge
              name={row.account.name}
              type={row.account.type}
              showType
              className="max-w-full"
            />
          ) : (
            <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground/60">
              Unassigned
            </span>
          )}
        </div>
      </div>

      <dl className="mt-4 grid min-w-0 grid-cols-2 gap-x-4 gap-y-3 border-t border-white/[0.06] pt-4">
        <MobilePositionMetric label="Shares">
          {fmtShares(Number(row.position.shares))}
        </MobilePositionMetric>
        <MobilePositionMetric label="Value">
          <span>{fmtMoney(row.currentValue, displayCurrency)}</span>
          {showNative && (
            <span className="block text-[10px] text-muted-foreground/60">
              {fmtMoney(row.nativeValue, row.currency)} {row.currency}
            </span>
          )}
        </MobilePositionMetric>
        <MobilePositionMetric label="Avg cost">
          <span>{fmtMoney(Number(row.position.avgCost), row.currency)}</span>
          <span className="ml-1 text-[10px] text-muted-foreground/60">{row.currency}</span>
        </MobilePositionMetric>
        <MobilePositionMetric label="Price">
          <span className="inline-flex max-w-full items-center gap-1.5">
            <StatusDot status={fresh ? 'fresh' : 'stale'} />
            <span className="truncate">
              {row.price ? fmtMoney(row.price.price, row.currency) : '—'}
            </span>
          </span>
        </MobilePositionMetric>
        <MobilePositionMetric label="P&amp;L $" className={pnlTone(row.pnlUsd)}>
          {fmtMoneySigned(row.pnlUsd, displayCurrency)}
        </MobilePositionMetric>
        <MobilePositionMetric label="P&amp;L %" className={pnlTone(row.pnlUsd)}>
          {fmtPct(row.pnlPct)}
        </MobilePositionMetric>
      </dl>

      <div className="mt-4 flex min-w-0 items-center justify-between gap-3 border-t border-white/[0.06] pt-3 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
        <span className="shrink-0">Sector</span>
        <span className="min-w-0 truncate text-right text-foreground/70">
          {row.position.sector ?? '—'}
        </span>
        <span className="shrink-0 text-muted-foreground/40">·</span>
        <span className="shrink-0">{fmtTimeAgo(row.position.updatedAt)}</span>
      </div>
    </article>
  );
}

function MobilePositionMetric({
  label,
  children,
  className,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div className="min-w-0">
      <dt className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </dt>
      <dd
        className={cn(
          'mt-1 min-w-0 break-words font-mono text-sm tabular-nums text-foreground',
          className,
        )}
      >
        {children}
      </dd>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  subtle,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  subtle?: string;
  tone?: 'neutral' | 'good' | 'bad' | 'warn';
}): React.ReactElement {
  const toneClass =
    tone === 'good'
      ? 'text-emerald-400'
      : tone === 'bad'
        ? 'text-rose-400'
        : tone === 'warn'
          ? 'text-amber-300'
          : 'text-foreground';
  return (
    <FrostedPanel className="flex min-w-0 flex-col gap-1 overflow-hidden p-4 md:p-5">
      <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          'min-w-0 break-words font-mono text-base font-medium tabular-nums sm:text-lg',
          toneClass,
        )}
      >
        {value}
      </div>
      {subtle && <div className="font-mono text-[10px] text-muted-foreground/60">{subtle}</div>}
    </FrostedPanel>
  );
}

function EmptyState(): React.ReactElement {
  return (
    <div className="flex flex-col items-center gap-4 px-6 py-16 text-center">
      <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
        Nothing on fire.
      </div>
      <p className="max-w-md text-sm text-muted-foreground">
        No positions yet. Add one manually or paste a CSV block from Wealthsimple on the bulk import
        page — then the thesis engine starts listening.
      </p>
      <div className="grid w-full max-w-sm grid-cols-2 gap-2 pt-2 [&>button]:min-h-11 [&>button]:justify-center">
        <AddPositionButton />
        <Link
          href="/portfolio/import"
          className="inline-flex min-h-11 items-center justify-center rounded-md border border-white/[0.08] px-3 py-2 font-mono text-xs uppercase tracking-[0.16em] text-muted-foreground transition hover:border-white/[0.2] hover:text-foreground sm:tracking-[0.2em]"
        >
          Bulk import
        </Link>
      </div>
    </div>
  );
}

// Used as sector-donut palette + legend swatch. Keep order matched to SectorDonut's COLORS.
function sliceColor(i: number): string {
  const palette = [
    '#5eead4',
    '#60a5fa',
    '#a78bfa',
    '#f472b6',
    '#facc15',
    '#34d399',
    '#fb923c',
    '#64748b',
  ];
  return palette[i % palette.length]!;
}
