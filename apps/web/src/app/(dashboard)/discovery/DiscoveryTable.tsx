/**
 * DiscoveryTable - client component.
 *
 * Filters: idea lens, sector dropdown, held/unheld toggle, min lens score.
 * Row actions: Add to watchlist, Bootstrap (proxy to worker), View news.
 */

'use client';

import * as React from 'react';
import {
  FileText,
  Microscope,
  RotateCcw,
  Star,
  TrendingUp,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { INCOME_RISK_PROFILES, type IncomeRiskKey } from '@vantage/core/goals/monthly-income';
import { cn } from '@/lib/utils';
import {
  LENS_LABELS,
  LENS_OPTIONS,
  MOBILE_SIGNAL_KEYS,
  RISK_OPTIONS,
  RISK_SHORT,
  SIGNAL_KEYS,
  SIGNAL_RANGES,
  buildReasons,
  defaultDiscoveryLens,
  hasDataForLens,
  humanCatalyst,
  incomeYield,
  incomeCadenceLabel,
  isCanadianListing,
  lensRead,
  passesLensRiskGate,
  prettySignalName,
  scoreForLens,
  strongestLens,
  type DiscoveryLens,
  type DiscoveryRisk,
  type SignalKey,
} from '@/lib/discoveryLens';
import { addWatchlist } from '../watchlist/actions';
import { bootstrapTickerAction, fetchRecentArticlesForTicker } from './actions';

export interface DiscoveryRow {
  ticker: string;
  name: string;
  sector: string | null;
  marketCapUsd: number | null;
  category: string | null;
  exchange: string;
  currency: 'USD' | 'CAD';
  score: number;
  scoreAvailable: boolean;
  breakdown: Record<string, number> | null;
  curatedIncome: boolean;
  incomeCadence: 'monthly' | null;
  incomeRiskFloor: IncomeRiskKey;
  incomeYieldEstimate: number | null;
  incomeYieldSource: 'metrics' | 'curated' | null;
  metrics: {
    dividendYieldTtm: number | null;
    dividendPayoutRatio: number | null;
    revenueGrowthYoy: number | null;
    epsGrowthYoy: number | null;
    peTtm: number | null;
    beta: number | null;
  } | null;
  computedAt: string | null;
  held: boolean;
  watchlisted: boolean;
  /**
   * Phase 17.9 - most recent catalyst MarketEvent for this ticker in the
   * last 30 days, if any. `kind` matches an EventKind enum value
   * (InsiderCluster, EarningsBeat, Material8K, AnalystUpgrade).
   */
  catalyst: { kind: string; occurredAt: string; details: string[] } | null;
}

const CATALYST_KIND_ICONS: Record<string, LucideIcon> = {
  InsiderCluster: Microscope,
  EarningsBeat: TrendingUp,
  Material8K: FileText,
  AnalystUpgrade: Star,
};

type HeldFilter = 'all' | 'unheld' | 'held';
type ExchangeFilter = 'all' | 'us' | 'ca';

type RankedRow = {
  row: DiscoveryRow;
  lensScore: number;
  reasons: string[];
  ideaType: DiscoveryLens;
};

type RecentArticle = {
  id: number;
  headline: string;
  publishedAt: string;
  source: string;
};

export function DiscoveryTable({
  rows,
  sectors,
}: {
  rows: DiscoveryRow[];
  sectors: string[];
}): React.ReactElement {
  const [sector, setSector] = React.useState<string>('all');
  const [heldFilter, setHeldFilter] = React.useState<HeldFilter>('unheld');
  const [exchangeFilter, setExchangeFilter] = React.useState<ExchangeFilter>('all');
  const [lens, setLens] = React.useState<DiscoveryLens>(() => defaultDiscoveryLens(rows));
  const [risk, setRisk] = React.useState<DiscoveryRisk>('moderate');
  const [minScore, setMinScore] = React.useState<number>(0);
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const [articlesByTicker, setArticlesByTicker] = React.useState<Record<string, RecentArticle[]>>(
    {},
  );
  const articleRequests = React.useRef(new Set<string>());
  const [catalystOnly, setCatalystOnly] = React.useState(false);

  const toggleExpandedTicker = (ticker: string) => {
    const opening = expanded !== ticker;
    setExpanded(opening ? ticker : null);
    if (!opening || articlesByTicker[ticker] !== undefined || articleRequests.current.has(ticker)) {
      return;
    }

    articleRequests.current.add(ticker);
    void fetchRecentArticlesForTicker(ticker)
      .then((articles) => {
        setArticlesByTicker((current) => ({ ...current, [ticker]: articles }));
      })
      .catch(() => {
        setArticlesByTicker((current) => ({ ...current, [ticker]: [] }));
      })
      .finally(() => {
        articleRequests.current.delete(ticker);
      });
  };

  const filtered = React.useMemo<RankedRow[]>(() => {
    const recent = Date.now() - 14 * 24 * 60 * 60 * 1000;
    return rows
      .map((row) => {
        const lensScore = scoreForLens(row, lens, risk);
        return {
          row,
          lensScore,
          reasons: buildReasons(row, lens, risk),
          ideaType: lens === 'raw' ? strongestLens(row, risk) : lens,
        };
      })
      .filter(({ row, lensScore }) => {
        if (sector !== 'all' && row.sector !== sector) return false;
        if (heldFilter === 'held' && !row.held) return false;
        if (heldFilter === 'unheld' && row.held) return false;
        if (exchangeFilter === 'us' && !isUsListing(row)) return false;
        if (exchangeFilter === 'ca' && !isCanadianListing(row)) return false;
        if (!hasDataForLens(row, lens)) return false;
        if (!passesLensRiskGate(row, lens, risk)) return false;
        if (lensScore < minScore) return false;
        if (catalystOnly) {
          if (!row.catalyst) return false;
          const t = new Date(row.catalyst.occurredAt).getTime();
          if (Number.isNaN(t) || t < recent) return false;
        }
        return true;
      })
      .sort((a, b) => b.lensScore - a.lensScore || b.row.score - a.row.score);
  }, [rows, lens, risk, sector, heldFilter, exchangeFilter, minScore, catalystOnly]);

  const visible = filtered.slice(0, 75);
  const selectedLens = LENS_OPTIONS.find((opt) => opt.key === lens);
  const selectedRisk = RISK_OPTIONS.find((opt) => opt.key === risk);
  const resetFilters = (): void => {
    setSector('all');
    setHeldFilter('all');
    setExchangeFilter('all');
    setMinScore(0);
    setCatalystOnly(false);
  };

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-end gap-3 border-b border-white/[0.06] px-4 py-3">
        <label className="flex w-full min-w-0 flex-col gap-1 sm:w-auto sm:min-w-[180px]">
          <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">
            Lens
          </span>
          <select
            value={lens}
            onChange={(e) => setLens(e.target.value as DiscoveryLens)}
            className="h-11 max-w-full rounded-md border border-white/[0.08] bg-black/30 px-3 text-xs outline-none focus:border-[var(--cc-accent)]/60 lg:h-8 lg:px-2"
          >
            {LENS_OPTIONS.map((opt) => (
              <option key={opt.key} value={opt.key}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex w-full min-w-0 flex-col gap-1 sm:w-auto sm:min-w-[160px]">
          <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">
            Risk
          </span>
          <select
            value={risk}
            onChange={(e) => setRisk(e.target.value as DiscoveryRisk)}
            className="h-11 max-w-full rounded-md border border-white/[0.08] bg-black/30 px-3 text-xs outline-none focus:border-[var(--cc-accent)]/60 lg:h-8 lg:px-2"
          >
            {RISK_OPTIONS.map((opt) => (
              <option key={opt.key} value={opt.key}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex w-full min-w-0 flex-col gap-1 sm:w-auto">
          <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">
            Sector
          </span>
          <select
            value={sector}
            onChange={(e) => setSector(e.target.value)}
            className="h-11 max-w-full rounded-md border border-white/[0.08] bg-black/30 px-3 text-xs outline-none focus:border-[var(--cc-accent)]/60 lg:h-8 lg:px-2"
          >
            <option value="all">All sectors</option>
            {sectors.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <div className="flex w-full min-w-0 flex-col gap-1 sm:w-auto">
          <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">
            Holdings
          </span>
          <div className="flex rounded-md border border-white/[0.08]">
            {(['all', 'unheld', 'held'] as HeldFilter[]).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setHeldFilter(k)}
                className={cn(
                  'min-h-11 min-w-0 flex-1 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] transition sm:flex-none lg:min-h-0',
                  heldFilter === k
                    ? 'bg-[var(--cc-accent)]/10 text-[var(--cc-accent)]'
                    : 'text-muted-foreground hover:bg-white/[0.04]',
                )}
              >
                {k}
              </button>
            ))}
          </div>
        </div>
        <div className="flex w-full min-w-0 flex-col gap-1 sm:w-auto">
          <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">
            Exchange
          </span>
          <div className="flex rounded-md border border-white/[0.08]">
            {(
              [
                ['all', 'All'],
                ['us', 'US'],
                ['ca', 'TSX/CA'],
              ] as Array<[ExchangeFilter, string]>
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setExchangeFilter(k)}
                className={cn(
                  'min-h-11 min-w-0 flex-1 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] transition sm:flex-none lg:min-h-0',
                  exchangeFilter === k
                    ? 'bg-[var(--cc-accent)]/10 text-[var(--cc-accent)]'
                    : 'text-muted-foreground hover:bg-white/[0.04]',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <label className="flex w-full min-w-0 flex-1 flex-col gap-1 sm:min-w-[200px]">
          <div className="flex items-baseline justify-between">
            <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">
              Min lens
            </span>
            <span className="font-mono text-[10px] tabular-nums text-foreground/70">
              {minScore.toFixed(2)}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={10}
            step={0.25}
            value={minScore}
            onChange={(e) => setMinScore(Number(e.target.value))}
            className="h-11 w-full accent-[var(--cc-accent)] lg:h-auto"
          />
        </label>
        <button
          type="button"
          onClick={() => setCatalystOnly(!catalystOnly)}
          className={cn(
            'min-h-11 w-full self-end rounded-md border px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] transition sm:w-auto lg:min-h-0',
            catalystOnly
              ? 'border-[var(--cc-accent)]/50 bg-[var(--cc-accent)]/10 text-[var(--cc-accent)]'
              : 'border-white/[0.08] text-muted-foreground hover:border-white/[0.2] hover:text-foreground',
          )}
          title="Show only tickers with a catalyst event in the last 14 days"
        >
          Active catalyst (14d)
        </button>
        <div className="ml-auto font-mono text-[10px] text-muted-foreground/70">
          {visible.length} shown / {filtered.length} matched / {rows.length} candidates
        </div>
        <div className="basis-full text-[11px] text-muted-foreground/70">
          {selectedLens?.note} · {selectedRisk?.note}
        </div>
      </div>

      <div className="hidden overflow-x-auto lg:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/[0.06] text-left font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              <th className="px-4 py-3">Ticker</th>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Sector</th>
              <th className="px-4 py-3">Catalyst</th>
              <th className="px-4 py-3 text-right">Lens</th>
              <th className="px-4 py-3 text-right">Raw</th>
              <th className="px-4 py-3">Why</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Computed</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-4 py-12">
                  <DiscoveryEmptyState lens={lens} risk={risk} onReset={resetFilters} />
                </td>
              </tr>
            ) : (
              visible.map(({ row: r, lensScore, reasons, ideaType }) => (
                <RowBody
                  key={r.ticker}
                  row={r}
                  lens={lens}
                  risk={risk}
                  lensScore={lensScore}
                  reasons={reasons}
                  ideaType={ideaType}
                  expanded={expanded === r.ticker}
                  articles={articlesByTicker[r.ticker] ?? null}
                  onToggleExpand={() => toggleExpandedTicker(r.ticker)}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="space-y-3 p-3 lg:hidden">
        {visible.length === 0 ? (
          <DiscoveryEmptyState lens={lens} risk={risk} onReset={resetFilters} />
        ) : (
          visible.map(({ row, lensScore, reasons, ideaType }) => (
            <MobileDiscoveryCard
              key={row.ticker}
              row={row}
              lens={lens}
              risk={risk}
              lensScore={lensScore}
              reasons={reasons}
              ideaType={ideaType}
              expanded={expanded === row.ticker}
              articles={articlesByTicker[row.ticker] ?? null}
              onToggleExpand={() => toggleExpandedTicker(row.ticker)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function DiscoveryEmptyState({
  lens,
  risk,
  onReset,
}: {
  lens: DiscoveryLens;
  risk: DiscoveryRisk;
  onReset: () => void;
}): React.ReactElement {
  const riskLabel = RISK_OPTIONS.find((option) => option.key === risk)?.label ?? risk;
  const floor = INCOME_RISK_PROFILES[risk].minYield * 100;
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <div>
        <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          No matching candidates
        </div>
        <p className="mt-1 text-xs text-muted-foreground/75">
          {lens === 'income'
            ? `${riskLabel} income requires monthly payouts and at least ${floor.toFixed(floor % 1 === 0 ? 0 : 1)}% yield with the active filters.`
            : 'No names clear the active filters and minimum lens score.'}
        </p>
      </div>
      <button
        type="button"
        onClick={onReset}
        className="inline-flex min-h-9 items-center gap-2 rounded-md border border-white/[0.1] bg-white/[0.03] px-3 text-xs text-muted-foreground transition hover:bg-white/[0.07] hover:text-foreground"
      >
        <RotateCcw className="size-3.5" aria-hidden />
        Reset filters
      </button>
    </div>
  );
}

function RowBody({
  row,
  lens,
  risk,
  lensScore,
  reasons,
  ideaType,
  expanded,
  articles,
  onToggleExpand,
}: {
  row: DiscoveryRow;
  lens: DiscoveryLens;
  risk: DiscoveryRisk;
  lensScore: number;
  reasons: string[];
  ideaType: DiscoveryLens;
  expanded: boolean;
  articles: RecentArticle[] | null;
  onToggleExpand: () => void;
}): React.ReactElement {
  const [busy, setBusy] = React.useState<'watch' | 'bootstrap' | null>(null);
  const [toast, setToast] = React.useState<string | null>(null);

  const stale = isStale(row.computedAt);
  const lensTone =
    lensScore >= 7.5 ? 'text-emerald-300' : lensScore < 4 ? 'text-amber-300' : 'text-foreground';

  const onWatch = async () => {
    setBusy('watch');
    setToast(null);
    const res = await addWatchlist(row.ticker, 'From discovery');
    setBusy(null);
    setToast(res.ok ? `Added ${row.ticker} to watchlist.` : (res.error ?? 'failed'));
  };

  const onBootstrap = async () => {
    setBusy('bootstrap');
    setToast(null);
    const res = await bootstrapTickerAction(row.ticker);
    setBusy(null);
    setToast(res.ok ? `Bootstrap queued for ${row.ticker}.` : (res.error ?? 'failed'));
  };

  return (
    <>
      <tr className="border-b border-white/[0.04] align-top hover:bg-white/[0.02]">
        <td className="px-4 py-3">
          <div className="flex items-center gap-2">
            <ExchangeBadge row={row} />
            <span className="font-mono text-sm font-semibold tabular-nums">{row.ticker}</span>
            {stale && (
              <span
                title="Score is more than 24h old"
                aria-label="stale score"
                className="inline-flex size-1.5 rounded-full bg-amber-400 shadow-[0_0_4px_#fbbf24]"
              />
            )}
          </div>
        </td>
        <td className="px-4 py-3 text-muted-foreground">{row.name}</td>
        <td className="px-4 py-3 font-mono text-[11px] text-muted-foreground">
          {row.sector ?? '-'}
        </td>
        <td className="px-4 py-3">
          <CatalystCell catalyst={row.catalyst} />
        </td>
        <td className={cn('px-4 py-3 text-right font-mono tabular-nums', lensTone)}>
          <div>{lensScore.toFixed(1)}</div>
          <div className="text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
            {LENS_LABELS[ideaType]} / {RISK_SHORT[risk]}
          </div>
        </td>
        <td className="px-4 py-3 text-right font-mono tabular-nums text-muted-foreground">
          {row.scoreAvailable ? row.score.toFixed(2) : '-'}
        </td>
        <td className="px-4 py-3">
          <ReasonList reasons={reasons} />
        </td>
        <td className="px-4 py-3">
          <div className="flex flex-wrap gap-1">
            {row.held && (
              <span className="rounded-full border border-[var(--cc-accent)]/40 bg-[var(--cc-accent)]/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.2em] text-[var(--cc-accent)]">
                Held
              </span>
            )}
            {row.watchlisted && (
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.2em] text-amber-300">
                Watching
              </span>
            )}
          </div>
        </td>
        <td className="px-4 py-3 font-mono text-[10px] text-muted-foreground/70">
          {timeAgo(row.computedAt)}
        </td>
        <td className="px-4 py-3 text-right">
          <div className="flex flex-wrap justify-end gap-1">
            {!row.watchlisted && !row.held && (
              <button
                type="button"
                onClick={onWatch}
                disabled={busy !== null}
                className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 font-mono text-[9px] uppercase tracking-[0.2em] text-amber-300 transition hover:bg-amber-500/20 disabled:opacity-40"
              >
                {busy === 'watch' ? '...' : 'Watch'}
              </button>
            )}
            <button
              type="button"
              onClick={onBootstrap}
              disabled={busy !== null}
              className="rounded-md border border-white/[0.1] bg-white/[0.03] px-2 py-1 font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground transition hover:bg-white/[0.08] hover:text-foreground disabled:opacity-40"
            >
              {busy === 'bootstrap' ? '...' : 'Bootstrap'}
            </button>
            <button
              type="button"
              onClick={onToggleExpand}
              className="rounded-md border border-white/[0.08] bg-white/[0.02] px-2 py-1 font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground transition hover:bg-white/[0.06] hover:text-foreground"
            >
              {expanded ? 'Hide news' : 'News'}
            </button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-white/[0.04] bg-white/[0.02]">
          <td colSpan={10} className="px-4 py-4">
            <ExpandedDiscoveryContent
              row={row}
              lens={lens}
              risk={risk}
              lensScore={lensScore}
              articles={articles}
            />
          </td>
        </tr>
      )}
      {toast && (
        <tr>
          <td colSpan={10} className="border-b border-white/[0.04] px-4 py-2">
            <div className="font-mono text-[10px] text-muted-foreground">{toast}</div>
          </td>
        </tr>
      )}
    </>
  );
}

function MobileDiscoveryCard({
  row,
  lens,
  risk,
  lensScore,
  reasons,
  ideaType,
  expanded,
  articles,
  onToggleExpand,
}: {
  row: DiscoveryRow;
  lens: DiscoveryLens;
  risk: DiscoveryRisk;
  lensScore: number;
  reasons: string[];
  ideaType: DiscoveryLens;
  expanded: boolean;
  articles: RecentArticle[] | null;
  onToggleExpand: () => void;
}): React.ReactElement {
  const [busy, setBusy] = React.useState<'watch' | 'bootstrap' | null>(null);
  const [toast, setToast] = React.useState<string | null>(null);
  const stale = isStale(row.computedAt);
  const lensTone =
    lensScore >= 7.5 ? 'text-emerald-300' : lensScore < 4 ? 'text-amber-300' : 'text-foreground';
  const signalKeys = mobileSignalKeys(lens, ideaType);

  const onWatch = async () => {
    setBusy('watch');
    setToast(null);
    const res = await addWatchlist(row.ticker, 'From discovery');
    setBusy(null);
    setToast(res.ok ? `Added ${row.ticker} to watchlist.` : (res.error ?? 'failed'));
  };

  const onBootstrap = async () => {
    setBusy('bootstrap');
    setToast(null);
    const res = await bootstrapTickerAction(row.ticker);
    setBusy(null);
    setToast(res.ok ? `Bootstrap queued for ${row.ticker}.` : (res.error ?? 'failed'));
  };

  return (
    <article className="cc-mobile-card min-w-0 p-4">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <ExchangeBadge row={row} />
            <span className="font-mono text-base font-semibold tabular-nums">{row.ticker}</span>
            {row.held && (
              <span className="rounded-full border border-[var(--cc-accent)]/40 bg-[var(--cc-accent)]/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.16em] text-[var(--cc-accent)]">
                Held
              </span>
            )}
            {row.watchlisted && (
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.16em] text-amber-300">
                Watching
              </span>
            )}
            {!row.held && !row.watchlisted && (
              <span className="rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.16em] text-muted-foreground">
                Candidate
              </span>
            )}
            {stale && (
              <span className="rounded-full border border-amber-500/30 bg-amber-500/[0.08] px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.16em] text-amber-300">
                Stale score
              </span>
            )}
          </div>
          <h3 className="mt-1 break-words text-sm font-medium text-foreground/90">{row.name}</h3>
          <div className="mt-1 break-words font-mono text-[10px] text-muted-foreground">
            {row.sector ?? 'Sector unavailable'}
            {row.category ? ` · ${row.category}` : ''}
          </div>
          <div className="mt-1 break-words font-mono text-[10px] text-muted-foreground/75">
            {listingDescription(row)}
          </div>
        </div>

        <div className="shrink-0 text-right">
          <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
            Lens
          </div>
          <div className={cn('font-mono text-xl tabular-nums', lensTone)}>
            {lensScore.toFixed(1)}
          </div>
          <div className="font-mono text-[9px] uppercase tracking-[0.16em] text-muted-foreground">
            {LENS_LABELS[ideaType]} / {RISK_SHORT[risk]}
          </div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <MobileDiscoveryMetric
          label="Raw score"
          value={row.scoreAvailable ? row.score.toFixed(2) : '-'}
        />
        <MobileDiscoveryMetric label="Computed" value={timeAgo(row.computedAt)} />
        <MobileDiscoveryMetric
          label={row.incomeYieldSource === 'curated' ? 'Est yield' : 'Yield'}
          value={formatIncomeYield(row)}
        />
        <MobileDiscoveryMetric label="Market cap" value={formatMarketCap(row.marketCapUsd)} />
      </div>

      <div className="mt-4 rounded-lg border border-white/[0.07] bg-black/15 p-3">
        <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
          Catalyst
        </div>
        {row.catalyst ? (
          <div className="mt-2 flex min-w-0 items-start gap-2">
            {React.createElement(CATALYST_KIND_ICONS[row.catalyst.kind] ?? Zap, {
              className: 'size-3.5 shrink-0 text-[var(--cc-accent)]',
              'aria-hidden': true,
            })}
            <div className="min-w-0">
              <div className="break-words text-xs font-medium text-foreground/85">
                {humanCatalyst(row.catalyst.kind)}
              </div>
              <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                {timeAgo(row.catalyst.occurredAt)}
              </div>
              {row.catalyst.details.map((detail) => (
                <div key={detail} className="mt-1 break-words text-xs text-foreground/65">
                  {detail}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="mt-2 text-xs text-muted-foreground">
            No catalyst event in the latest discovery window.
          </div>
        )}
      </div>

      <div className="mt-4">
        <div className="mb-2 font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
          Why it ranks
        </div>
        <ReasonList reasons={reasons} />
      </div>

      <div className="mt-4">
        <div className="mb-2 font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
          Key {LENS_LABELS[lens === 'raw' ? ideaType : lens]} signals
        </div>
        {row.breakdown ? (
          <div className="grid grid-cols-2 gap-2">
            {signalKeys.map((key) => {
              const value = row.breakdown?.[key] ?? 0;
              return (
                <MobileDiscoveryMetric
                  key={key}
                  label={prettySignalName(key)}
                  value={formatSignalValue(key, value)}
                  tone={value > 0 ? 'text-emerald-300' : value < 0 ? 'text-rose-300' : undefined}
                />
              );
            })}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">No signal breakdown available.</div>
        )}
      </div>

      <div
        className={cn(
          'mt-4 grid gap-2',
          !row.watchlisted && !row.held ? 'grid-cols-3' : 'grid-cols-2',
        )}
      >
        {!row.watchlisted && !row.held && (
          <button
            type="button"
            onClick={onWatch}
            disabled={busy !== null}
            className="min-h-11 min-w-0 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 font-mono text-[9px] uppercase tracking-[0.12em] text-amber-300 transition hover:bg-amber-500/20 disabled:opacity-40"
          >
            {busy === 'watch' ? '...' : 'Watch'}
          </button>
        )}
        <button
          type="button"
          onClick={onBootstrap}
          disabled={busy !== null}
          className="min-h-11 min-w-0 rounded-md border border-white/[0.1] bg-white/[0.03] px-2 font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground transition hover:bg-white/[0.08] hover:text-foreground disabled:opacity-40"
        >
          {busy === 'bootstrap' ? '...' : 'Bootstrap'}
        </button>
        <button
          type="button"
          onClick={onToggleExpand}
          aria-expanded={expanded}
          className="min-h-11 min-w-0 rounded-md border border-white/[0.08] bg-white/[0.02] px-2 font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground transition hover:bg-white/[0.06] hover:text-foreground"
        >
          {expanded ? 'Hide news' : 'News + details'}
        </button>
      </div>

      {toast && (
        <div
          role="status"
          className="mt-3 rounded-md border border-white/[0.06] bg-white/[0.02] px-3 py-2 font-mono text-[10px] text-muted-foreground"
        >
          {toast}
        </div>
      )}

      {expanded && (
        <div className="mt-4 min-w-0 border-t border-white/[0.06] pt-4">
          <ExpandedDiscoveryContent
            row={row}
            lens={lens}
            risk={risk}
            lensScore={lensScore}
            articles={articles}
          />
        </div>
      )}
    </article>
  );
}

function MobileDiscoveryMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: string;
}): React.ReactElement {
  return (
    <div className="min-w-0 rounded-md border border-white/[0.06] bg-white/[0.02] p-2">
      <div className="truncate font-mono text-[9px] uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </div>
      <div
        className={cn('mt-1 break-words font-mono text-xs tabular-nums text-foreground/85', tone)}
      >
        {value}
      </div>
    </div>
  );
}

function ExpandedDiscoveryContent({
  row,
  lens,
  risk,
  lensScore,
  articles,
}: {
  row: DiscoveryRow;
  lens: DiscoveryLens;
  risk: DiscoveryRisk;
  lensScore: number;
  articles: RecentArticle[] | null;
}): React.ReactElement {
  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.65fr)]">
      <ScoreDetails row={row} lens={lens} risk={risk} lensScore={lensScore} />
      <div className="min-w-0">
        <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          Recent news
        </div>
        {articles === null ? (
          <div className="font-mono text-[10px] text-muted-foreground">Loading articles...</div>
        ) : articles.length === 0 ? (
          <div className="font-mono text-[10px] text-muted-foreground">
            No recent articles for {row.ticker}.
          </div>
        ) : (
          <ul className="flex min-w-0 flex-col gap-2">
            {articles.map((article) => (
              <li key={article.id} className="min-w-0 text-xs">
                <div className="font-mono text-[10px] text-muted-foreground/70">
                  {timeAgo(article.publishedAt)} · {article.source}
                </div>
                <div className="mt-0.5 break-words text-foreground/80">{article.headline}</div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function mobileSignalKeys(lens: DiscoveryLens, ideaType: DiscoveryLens): readonly SignalKey[] {
  const activeLens = lens === 'raw' ? ideaType : lens;
  return activeLens === 'raw' ? MOBILE_SIGNAL_KEYS.quality : MOBILE_SIGNAL_KEYS[activeLens];
}

function listingDescription(row: DiscoveryRow): string {
  return `${isCanadianListing(row) ? 'Canadian' : 'US'} listing · ${row.exchange} · ${row.currency}`;
}

function formatMarketCap(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '-';
  return `$${value.toLocaleString('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  })}`;
}

function ReasonList({ reasons }: { reasons: string[] }): React.ReactElement {
  if (reasons.length === 0) {
    return <span className="font-mono text-[10px] text-muted-foreground/60">no clear thesis</span>;
  }
  return (
    <div className="flex max-w-[360px] flex-wrap gap-1.5">
      {reasons.slice(0, 4).map((reason) => (
        <span
          key={reason}
          className="rounded border border-white/[0.08] bg-white/[0.03] px-2 py-0.5 text-[11px] text-foreground/75"
        >
          {reason}
        </span>
      ))}
    </div>
  );
}

function ScoreDetails({
  row,
  lens,
  risk,
  lensScore,
}: {
  row: DiscoveryRow;
  lens: DiscoveryLens;
  risk: DiscoveryRisk;
  lensScore: number;
}): React.ReactElement {
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            Lens score
          </div>
          <div className="font-mono text-lg tabular-nums">
            {lensScore.toFixed(1)}
            <span className="ml-1 text-xs text-muted-foreground">/ 10</span>
          </div>
        </div>
        <div className="h-8 w-px bg-white/[0.08]" />
        <div className="min-w-[220px]">
          <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            Signals
          </div>
          <SignalBars breakdown={row.breakdown} />
        </div>
        <MetricPill
          label={row.incomeYieldSource === 'curated' ? 'est yield' : 'yield'}
          value={formatIncomeYield(row)}
        />
        <MetricPill label="cadence" value={incomeCadenceLabel(row)} />
        <MetricPill label="revenue" value={formatPercent(row.metrics?.revenueGrowthYoy)} />
        <MetricPill label="eps" value={formatPercent(row.metrics?.epsGrowthYoy)} />
        <MetricPill label="p/e" value={formatMultiple(row.metrics?.peTtm)} />
        <MetricPill label="beta" value={formatNumber(row.metrics?.beta)} />
      </div>
      <div className="grid grid-cols-2 gap-2 xl:grid-cols-7">
        {SIGNAL_KEYS.map((key) => (
          <div key={key} className="rounded border border-white/[0.06] bg-black/15 p-2">
            <div className="truncate font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
              {prettySignalName(key)}
            </div>
            <div className="mt-1 font-mono text-[12px] tabular-nums text-foreground/85">
              {formatSignalValue(key, row.breakdown?.[key] ?? 0)}
            </div>
          </div>
        ))}
      </div>
      <div className="text-[11px] text-muted-foreground/75">
        Reading as {LENS_LABELS[lens]} / {RISK_OPTIONS.find((opt) => opt.key === risk)?.label}:{' '}
        {lensRead(row, lens, risk)}.
      </div>
    </div>
  );
}

function MetricPill({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="rounded border border-white/[0.08] bg-black/20 px-2 py-1">
      <div className="font-mono text-[8px] uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </div>
      <div className="font-mono text-[11px] tabular-nums text-foreground/85">{value}</div>
    </div>
  );
}

function ExchangeBadge({ row }: { row: DiscoveryRow }): React.ReactElement {
  const isCa = isCanadianListing(row);
  const flag = isCa ? '🇨🇦' : '🇺🇸';
  const title = `${isCa ? 'Canadian' : 'US'} listing · ${row.exchange} · ${row.currency}`;
  return (
    <span
      title={title}
      aria-label={title}
      className={cn(
        'inline-flex items-center rounded border px-1.5 text-[10px]',
        isCa
          ? 'border-[var(--cc-accent)]/30 bg-[var(--cc-accent)]/5'
          : 'border-white/10 bg-white/[0.03]',
      )}
    >
      {flag}
    </span>
  );
}

function SignalBars({
  breakdown,
}: {
  breakdown: Record<string, number> | null;
}): React.ReactElement {
  if (!breakdown) {
    return <span className="font-mono text-[10px] text-muted-foreground/60">-</span>;
  }
  return (
    <div
      className="flex items-end gap-0.5"
      title={SIGNAL_KEYS.map((k) => `${k}: ${(breakdown[k] ?? 0).toFixed(2)}`).join(' · ')}
    >
      {SIGNAL_KEYS.map((k) => {
        const { min, max } = SIGNAL_RANGES[k];
        const raw = breakdown[k] ?? 0;
        const span = max - min;
        const norm = span > 0 ? (raw - min) / span : 0;
        const height = Math.max(4, Math.min(24, Math.round(norm * 24)));
        const tone = raw > 0 ? 'bg-emerald-400/80' : raw < 0 ? 'bg-rose-400/70' : 'bg-white/40';
        return (
          <span
            key={k}
            aria-label={k}
            className={cn('w-1 rounded-sm', tone)}
            style={{ height: `${height}px` }}
          />
        );
      })}
    </div>
  );
}

function CatalystCell({
  catalyst,
}: {
  catalyst: { kind: string; occurredAt: string; details: string[] } | null;
}): React.ReactElement {
  if (!catalyst) {
    return <span className="font-mono text-[10px] text-muted-foreground/40">-</span>;
  }
  const Icon = CATALYST_KIND_ICONS[catalyst.kind] ?? Zap;
  return (
    <div className="max-w-[34ch]" title={catalyst.kind}>
      <div className="flex items-center gap-1.5">
        <Icon className="size-3.5 shrink-0 text-[var(--cc-accent)]" aria-hidden />
        <span className="text-xs text-foreground/80">{humanCatalyst(catalyst.kind)}</span>
        <span className="font-mono text-[9px] text-muted-foreground">
          {timeAgo(catalyst.occurredAt)}
        </span>
      </div>
      {catalyst.details.slice(0, 2).map((detail) => (
        <div
          key={detail}
          className="mt-1 line-clamp-2 text-[10px] leading-relaxed text-muted-foreground"
        >
          {detail}
        </div>
      ))}
    </div>
  );
}

function isUsListing(row: DiscoveryRow): boolean {
  return !isCanadianListing(row) && row.currency === 'USD';
}

function formatPercent(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  return `${value.toFixed(Math.abs(value) >= 10 ? 0 : 1)}%`;
}

function formatIncomeYield(row: DiscoveryRow): string {
  const ratio = incomeYield(row);
  if (!(ratio > 0)) return '-';
  return `${(ratio * 100).toFixed(ratio >= 0.1 ? 0 : 1)}%`;
}

function formatMultiple(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return '-';
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)}x`;
}

function formatNumber(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  return value.toFixed(2);
}

function formatSignalValue(key: SignalKey, value: number): string {
  if (key === 'momentum' || key === 'earnings' || key === 'insider') {
    return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
  }
  if (key === 'sentiment') {
    return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
  }
  return value.toFixed(1);
}

function isStale(computedAt: string | null): boolean {
  if (!computedAt) return false;
  const ageMs = Date.now() - new Date(computedAt).getTime();
  return ageMs > 24 * 3600_000;
}

function timeAgo(iso: string | null): string {
  if (!iso) return 'unscored';
  const diff = Date.now() - new Date(iso).getTime();
  const hours = Math.round(diff / 3600_000);
  if (hours < 1) return '<1h';
  if (hours < 48) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}
