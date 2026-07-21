/**
 * CompareTable — unified ranking of held positions + market candidates.
 *
 * Rows for held positions get a subtle cyan tint + filled circle glyph so
 * they stand out in the ordered list. Score bar uses the same palette as
 * /discovery (emerald positive, rose negative). Hovering the signal mini-bar
 * surfaces the exact breakdown.
 */

'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import type { CompareRow } from './data';
import type { ThesisStatus } from '@vantage/db';
import type { DiscoveryWeights, SignalBreakdown } from '@vantage/core/discover/signals';
import type { Verdict, VerdictTone } from '@vantage/core/verdict';
import {
  RISK_OPTIONS,
  SIGNAL_KEYS,
  SIGNAL_RANGES,
  buildReasons,
  canadianExchangeName,
  isCanadianListing,
  passesLensRiskGate,
  prettySignalName,
  scoreForLens,
  type DiscoveryLens,
  type DiscoveryRisk,
} from '@/lib/discoveryLens';

type HeldFilter = 'all' | 'held' | 'unheld';

export function CompareTable({
  rows,
  signalWeights,
  swapTickers,
}: {
  rows: CompareRow[];
  signalWeights: DiscoveryWeights;
  swapTickers: string[];
}): React.ReactElement {
  const [filter, setFilter] = React.useState<HeldFilter>('all');
  const [limit, setLimit] = React.useState<number>(40);
  const [lens, setLens] = React.useState<Exclude<DiscoveryLens, 'catalyst'>>('raw');
  const [risk, setRisk] = React.useState<DiscoveryRisk>('moderate');
  const swapSet = React.useMemo(() => new Set(swapTickers), [swapTickers]);

  const filtered = React.useMemo(() => {
    const base =
      filter === 'held'
        ? rows.filter((r) => r.held)
        : filter === 'unheld'
          ? rows.filter((r) => !r.held)
          : rows;
    return base
      .filter((row) => row.held || passesLensRiskGate(row, lens, risk))
      .map((row) => ({ row, lensScore: scoreForLens(row, lens, risk) }))
      .sort((a, b) => b.lensScore - a.lensScore || b.row.score - a.row.score)
      .slice(0, limit);
  }, [rows, filter, lens, risk, limit]);

  const heldCount = rows.filter((r) => r.held).length;
  const unheldCount = rows.length - heldCount;

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-white/[0.06] px-4 py-3">
        <div className="flex rounded-md border border-white/[0.08]">
          {(
            [
              ['raw', 'Raw'],
              ['growth', 'Growth'],
              ['income', 'Income'],
              ['quality', 'Quality'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setLens(key)}
              className={cn(
                'h-7 px-3 font-mono text-[10px] uppercase tracking-[0.16em] transition',
                lens === key
                  ? 'bg-[var(--cc-accent)]/10 text-[var(--cc-accent)]'
                  : 'text-muted-foreground hover:bg-white/[0.04]',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          Risk
          <select
            value={risk}
            onChange={(event) => setRisk(event.target.value as DiscoveryRisk)}
            className="h-7 rounded-md border border-white/[0.08] bg-black/30 px-2 text-xs text-foreground outline-none focus:border-[var(--cc-accent)]/60"
          >
            {RISK_OPTIONS.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <div className="flex w-full rounded-md border border-white/[0.08] lg:w-auto">
          {(
            [
              ['all', `All (${rows.length})`],
              ['held', `Held (${heldCount})`],
              ['unheld', `Candidates (${unheldCount})`],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setFilter(k)}
              className={cn(
                'min-h-11 min-w-0 flex-1 px-2 py-1 font-mono text-[9px] uppercase tracking-[0.12em] transition sm:text-[10px] sm:tracking-[0.2em] lg:min-h-0 lg:flex-none lg:px-3',
                filter === k
                  ? 'bg-[var(--cc-accent)]/10 text-[var(--cc-accent)]'
                  : 'text-muted-foreground hover:bg-white/[0.04]',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex w-full items-center justify-between gap-3 sm:w-auto">
          <label className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            Show
            <select
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="h-11 rounded-md border border-white/[0.08] bg-black/30 px-3 text-xs outline-none focus:border-[var(--cc-accent)]/60 lg:h-7 lg:px-2"
            >
              {[20, 40, 80, 200].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <span className="font-mono text-[10px] text-muted-foreground/70">
            {filtered.length} shown · {lens} lens
          </span>
        </div>
      </div>

      <div className="hidden overflow-x-auto lg:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/[0.06] text-left font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              <th className="w-10 px-3 py-3 text-center">Own</th>
              <th className="px-3 py-3">Ticker</th>
              <th className="px-3 py-3">Name</th>
              <th className="px-3 py-3">Context</th>
              <th className="px-3 py-3 text-right">{lens === 'raw' ? 'Raw' : 'Lens'}</th>
              <th className="px-3 py-3">Verdict</th>
              <th className="px-3 py-3">Signals / trend</th>
              <th className="px-3 py-3">Thesis</th>
              <th className="px-3 py-3 text-right">30d</th>
              <th className="px-3 py-3 text-right">6mo</th>
              <th className="px-3 py-3 text-right">1y</th>
              <th className="px-3 py-3 text-right">Value</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(({ row, lensScore }) => (
              <Row
                key={row.ticker}
                row={row}
                lens={lens}
                risk={risk}
                lensScore={lensScore}
                signalWeights={signalWeights}
                hasSwap={swapSet.has(row.ticker)}
              />
            ))}
          </tbody>
        </table>
      </div>

      <div className="space-y-3 p-3 lg:hidden">
        {filtered.map(({ row }) => (
          <MobileCompareCard key={row.ticker} row={row} />
        ))}
      </div>
    </div>
  );
}

function MobileCompareCard({ row }: { row: CompareRow }): React.ReactElement {
  const scoreTone =
    row.score >= 6 ? 'text-emerald-300' : row.score < 0 ? 'text-rose-300' : 'text-foreground';
  const cardTint = row.held ? 'bg-[var(--cc-accent)]/[0.035]' : 'bg-transparent';

  return (
    <article className={cn('cc-mobile-card min-w-0 p-4', cardTint)}>
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <ExchangeBadge row={row} />
            <span
              className={cn(
                'font-mono text-base font-semibold tabular-nums',
                row.held ? 'text-[var(--cc-accent)]' : 'text-foreground',
              )}
            >
              {row.ticker}
            </span>
            <span
              className={cn(
                'rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.16em]',
                row.held
                  ? 'border-[var(--cc-accent)]/40 bg-[var(--cc-accent)]/10 text-[var(--cc-accent)]'
                  : 'border-white/10 bg-white/[0.03] text-muted-foreground',
              )}
            >
              {row.held ? 'Owned' : 'Candidate'}
            </span>
            {row.watchlisted && !row.held && (
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.16em] text-amber-300">
                Watching
              </span>
            )}
            {row.stale && (
              <span className="rounded-full border border-amber-500/30 bg-amber-500/[0.08] px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.16em] text-amber-300">
                Stale score
              </span>
            )}
          </div>
          <div className="mt-1 break-words text-sm text-foreground/85">
            {row.name ?? 'Name unavailable'}
          </div>
          <div className="mt-1 break-words font-mono text-[10px] text-muted-foreground">
            {row.sector ?? 'Sector unavailable'} · {exchangeDescription(row)}
          </div>
        </div>

        <div className="shrink-0 text-right">
          <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
            Score
          </div>
          <div className={cn('font-mono text-xl tabular-nums', scoreTone)}>
            {row.score >= 0 ? '+' : ''}
            {row.score.toFixed(2)}
          </div>
        </div>
      </div>

      <div className="mt-4 rounded-lg border border-white/[0.07] bg-black/15 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
            Verdict
          </span>
          <VerdictPill verdict={row.verdict} />
        </div>
        <p className="mt-2 break-words text-xs leading-relaxed text-foreground/75">
          {row.verdict.rationale}
        </p>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <MobileMetric
          label="30d"
          value={formatReturn(row.thirtyDayReturnPct)}
          tone={returnTone(row.thirtyDayReturnPct)}
        />
        <MobileMetric
          label="6mo"
          value={formatReturn(row.r6moPct)}
          tone={returnTone(row.r6moPct)}
        />
        <MobileMetric label="1y" value={formatReturn(row.r1yPct)} tone={returnTone(row.r1yPct)} />
        <MobileMetric label="Value" value={formatValue(row.valueUsd)} />
        <div className="min-w-0 rounded-md border border-white/[0.06] bg-white/[0.02] p-2 sm:col-span-2">
          <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
            Thesis
          </div>
          <div className="mt-1">
            {row.held ? (
              <ThesisBadge status={row.thesisStatus} />
            ) : (
              <span className="font-mono text-[10px] text-muted-foreground/60">Not held</span>
            )}
          </div>
        </div>
      </div>

      <div className="mt-4">
        <div className="mb-2 font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
          Signal breakdown
        </div>
        {row.breakdown ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {SIGNAL_KEYS.map((key) => {
              const value = row.breakdown?.[key] ?? 0;
              return (
                <MobileMetric
                  key={key}
                  label={key}
                  value={value.toFixed(2)}
                  tone={value > 0 ? 'text-emerald-300' : value < 0 ? 'text-rose-300' : undefined}
                />
              );
            })}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">No signal breakdown available.</div>
        )}
      </div>
    </article>
  );
}

function MobileMetric({
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
      <div className="truncate font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
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

function formatReturn(value: number | null): string {
  if (value === null) return '-';
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function returnTone(value: number | null): string | undefined {
  if (value === null) return undefined;
  if (value > 1) return 'text-emerald-300';
  if (value < -1) return 'text-rose-300';
  return 'text-zinc-400';
}

function formatValue(value: number | null): string {
  if (value === null) return '-';
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function exchangeDescription(row: CompareRow): string {
  if (isCanadianListing(row)) return `${canadianExchangeName(row)} · CAD`;
  return `${row.exchange || 'US'} listing · USD`;
}

function Row({
  row,
  lens,
  risk,
  lensScore,
  signalWeights,
  hasSwap,
}: {
  row: CompareRow;
  lens: Exclude<DiscoveryLens, 'catalyst'>;
  risk: DiscoveryRisk;
  lensScore: number;
  signalWeights: DiscoveryWeights;
  hasSwap: boolean;
}): React.ReactElement {
  const scoreTone =
    lensScore >= 6 ? 'text-emerald-300' : lensScore < 0 ? 'text-rose-300' : 'text-foreground';
  const tintClass = row.held
    ? 'bg-[var(--cc-accent)]/[0.04] hover:bg-[var(--cc-accent)]/[0.07]'
    : 'hover:bg-white/[0.02]';

  return (
    <>
      <tr className={cn('border-b border-white/[0.025] align-middle transition', tintClass)}>
        <td className="px-3 py-2.5 text-center">
          <OwnGlyph held={row.held} />
        </td>
        <td className="px-3 py-2.5">
          <div className="flex items-center gap-2">
            <ExchangeBadge row={row} />
            <span
              className={cn(
                'font-mono text-sm font-semibold tabular-nums',
                row.held ? 'text-[var(--cc-accent)]' : 'text-foreground',
              )}
            >
              {row.ticker}
            </span>
            {row.stale && (
              <span
                title="score older than 24h"
                aria-label="stale score"
                className="inline-flex size-1.5 rounded-full bg-amber-400 shadow-[0_0_4px_#fbbf24]"
              />
            )}
            {row.watchlisted && !row.held && (
              <span
                title="on watchlist"
                aria-label="watchlisted"
                className="inline-flex size-1.5 rounded-full bg-amber-400/80"
              />
            )}
          </div>
          <PriceFreshness row={row} />
        </td>
        <td className="max-w-[220px] px-3 py-2.5">
          <div className="truncate text-muted-foreground">{row.name ?? '-'}</div>
          <div className="truncate font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground/55">
            {row.sector ?? 'sector unavailable'}
          </div>
        </td>
        <td className="px-3 py-2.5">
          <div className="flex max-w-[180px] flex-wrap gap-1">
            <AnalystBadge analyst={row.analyst} />
            <CatalystBadge catalyst={row.catalyst} />
          </div>
        </td>
        <td className="px-3 py-2.5 text-right">
          <div className="flex items-center justify-end gap-2">
            <ScoreBar score={lensScore} />
            <div>
              <div className={cn('font-mono text-sm tabular-nums', scoreTone)}>
                {lensScore >= 0 ? '+' : ''}
                {lensScore.toFixed(2)}
              </div>
              {lens !== 'raw' && (
                <div className="font-mono text-[9px] tabular-nums text-muted-foreground/55">
                  raw {row.score.toFixed(2)}
                </div>
              )}
            </div>
          </div>
        </td>
        <td className="px-3 py-2.5">
          {row.verdict.kind === 'TRIM' && hasSwap ? (
            <a
              href={`#swap-${anchorTicker(row.ticker)}`}
              className="inline-flex rounded-full outline-none ring-offset-2 ring-offset-black focus-visible:ring-2 focus-visible:ring-[var(--cc-accent)]"
              title="Jump to this ticker's replacement"
            >
              <VerdictPill verdict={row.verdict} />
            </a>
          ) : (
            <VerdictPill verdict={row.verdict} />
          )}
        </td>
        <td className="px-3 py-2.5">
          <div className="flex items-center gap-2">
            <SignalBars breakdown={row.breakdown} weights={signalWeights} />
            <ScoreSparkline values={row.scoreTrend} />
          </div>
        </td>
        <td className="px-3 py-2.5">
          {row.held ? (
            <ThesisBadge status={row.thesisStatus} />
          ) : (
            <span className="font-mono text-[10px] text-muted-foreground/60">-</span>
          )}
        </td>
        <ReturnCell value={row.thirtyDayReturnPct} alpha={row.alpha30Pct} />
        <ReturnCell value={row.r6moPct} alpha={row.alpha6moPct} />
        <ReturnCell value={row.r1yPct} alpha={row.alpha1yPct} />
        <td className="px-3 py-2.5 text-right font-mono tabular-nums text-muted-foreground">
          {row.valueUsd === null
            ? '-'
            : `$${row.valueUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })}`}
        </td>
      </tr>
      <tr
        className={cn('border-b border-white/[0.055]', row.held && 'bg-[var(--cc-accent)]/[0.025]')}
      >
        <td colSpan={12} className="px-3 pb-2.5 pt-1">
          <ResearchStrip row={row} lens={lens} risk={risk} />
        </td>
      </tr>
    </>
  );
}

function ResearchStrip({
  row,
  lens,
  risk,
}: {
  row: CompareRow;
  lens: Exclude<DiscoveryLens, 'catalyst'>;
  risk: DiscoveryRisk;
}): React.ReactElement {
  const metrics = row.metrics;
  const reasons = buildReasons(row, lens, risk).slice(0, 3).join(' · ');

  return (
    <div className="flex min-h-7 flex-wrap items-center gap-x-4 gap-y-1 pl-10 font-mono text-[9px] text-muted-foreground/70">
      <ResearchMetric label="P/E" value={formatMultiple(metrics?.peTtm)} />
      <ResearchMetric label="EV/EBITDA" value={formatMultiple(metrics?.evToEbitda)} />
      <ResearchMetric label="ROE" value={formatRatio(metrics?.roeTtm)} />
      <ResearchMetric label="gross" value={formatRatio(metrics?.grossMarginTtm)} />
      <ResearchMetric label="op margin" value={formatRatio(metrics?.operatingMarginTtm)} />
      <ResearchMetric label="net margin" value={formatRatio(metrics?.netMarginTtm)} />
      <ResearchMetric label="D/E" value={formatNumber(metrics?.debtToEquity)} />
      <ResearchMetric label="yield" value={formatRatio(metrics?.dividendYieldTtm)} />
      <ResearchMetric label="payout" value={formatRatio(metrics?.dividendPayoutRatio)} />
      <ResearchMetric
        label="52w"
        value={
          row.low52 === null || row.high52 === null
            ? '-'
            : `${formatPrice(row.low52, row.currency)}-${formatPrice(row.high52, row.currency)}`
        }
      />
      <ResearchMetric label="from high" value={formatReturn(row.fromHighPct)} />
      <span className="ml-auto max-w-[42rem] truncate text-foreground/55" title={reasons}>
        {reasons}
      </span>
    </div>
  );
}

function ResearchMetric({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <span className="whitespace-nowrap">
      <span className="uppercase tracking-[0.12em] text-muted-foreground/45">{label}</span>{' '}
      <span className="tabular-nums text-foreground/70">{value}</span>
    </span>
  );
}

function PriceFreshness({ row }: { row: CompareRow }): React.ReactElement {
  if (row.latestPrice === null) {
    return (
      <div className="mt-1 font-mono text-[9px] text-muted-foreground/45">price unavailable</div>
    );
  }
  const label = row.priceIsLive ? `live ${formatAge(row.priceAgeSeconds)}` : 'last close';
  return (
    <div
      className={cn(
        'mt-1 font-mono text-[9px] uppercase tracking-[0.12em]',
        row.priceIsLive ? 'text-emerald-300/75' : 'text-muted-foreground/55',
      )}
      title={`${formatPrice(row.latestPrice, row.currency)} · ${label}`}
    >
      {label} · {formatPrice(row.latestPrice, row.currency)}
    </div>
  );
}

function AnalystBadge({ analyst }: { analyst: CompareRow['analyst'] }): React.ReactElement {
  if (!analyst) {
    return <span className="font-mono text-[9px] text-muted-foreground/40">no analyst read</span>;
  }
  const bullish = analyst.strongBuy + analyst.buy;
  const bearish = analyst.sell + analyst.strongSell;
  const label = analyst.consensus.replace(/([a-z])([A-Z])/g, '$1 $2');
  const tone =
    analyst.consensus === 'StrongBuy' || analyst.consensus === 'Buy'
      ? 'border-emerald-500/25 bg-emerald-500/[0.06] text-emerald-300/85'
      : analyst.consensus === 'Sell' || analyst.consensus === 'StrongSell'
        ? 'border-rose-500/25 bg-rose-500/[0.06] text-rose-300/85'
        : 'border-white/10 bg-white/[0.03] text-muted-foreground';
  return (
    <span
      className={cn(
        'rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em]',
        tone,
      )}
      title={`Strong buy ${analyst.strongBuy}, buy ${analyst.buy}, hold ${analyst.hold}, sell ${analyst.sell}, strong sell ${analyst.strongSell}`}
    >
      {label} ({bullish}/{analyst.hold}/{bearish})
    </span>
  );
}

function CatalystBadge({
  catalyst,
}: {
  catalyst: CompareRow['catalyst'];
}): React.ReactElement | null {
  if (!catalyst) return null;
  const labels: Record<string, string> = {
    InsiderCluster: 'Insider cluster',
    EarningsBeat: 'Earnings beat',
    Material8K: 'Material 8-K',
    AnalystUpgrade: 'Analyst upgrade',
  };
  return (
    <span
      className="rounded border border-amber-500/25 bg-amber-500/[0.06] px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em] text-amber-300/85"
      title={new Date(catalyst.occurredAt).toLocaleString('en-CA')}
    >
      {labels[catalyst.kind] ?? catalyst.kind} · {formatEventAge(catalyst.occurredAt)}
    </span>
  );
}

function ScoreSparkline({ values }: { values: number[] }): React.ReactElement {
  if (values.length < 2) {
    return (
      <span className="inline-block h-6 w-[72px] font-mono text-[9px] text-muted-foreground/35">
        trend -
      </span>
    );
  }
  const width = 72;
  const height = 24;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(max - min, 0.001);
  const points = values
    .map((value, index) => {
      const x = (index / Math.max(values.length - 1, 1)) * width;
      const y = height - 2 - ((value - min) / span) * (height - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const rising = (values.at(-1) ?? 0) >= (values[0] ?? 0);
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`30 day score trend, ${rising ? 'rising' : 'falling'}`}
      className={rising ? 'text-emerald-400/80' : 'text-rose-400/80'}
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m`;
}

function formatEventAge(iso: string): string {
  const hours = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000));
  if (hours < 1) return '<1h';
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatPrice(value: number, currency: 'USD' | 'CAD'): string {
  return `${currency === 'CAD' ? 'C$' : '$'}${value.toFixed(value >= 100 ? 0 : 2)}`;
}

function formatMultiple(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return '-';
  return `${value.toFixed(value >= 10 ? 1 : 2)}x`;
}

function formatRatio(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  return `${value.toFixed(1)}%`;
}

function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  return value.toFixed(2);
}

function anchorTicker(ticker: string): string {
  return ticker.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

/** Color-coded return cell shared by 30d/6mo/1y. Thresholds: ±1% (anything
 * between is muted) so the three columns don't visually thrash on noise. */
function ReturnCell({
  value,
  alpha,
}: {
  value: number | null;
  alpha: number | null;
}): React.ReactElement {
  if (value === null) {
    return (
      <td className="px-3 py-2.5 text-right font-mono tabular-nums text-muted-foreground/60">-</td>
    );
  }
  const tone = value > 1 ? 'text-emerald-300' : value < -1 ? 'text-rose-300' : 'text-zinc-400';
  const alphaTone =
    alpha === null
      ? 'text-muted-foreground/40'
      : alpha > 0.5
        ? 'text-emerald-300/70'
        : alpha < -0.5
          ? 'text-rose-300/70'
          : 'text-muted-foreground/55';
  return (
    <td className="px-3 py-2.5 text-right font-mono tabular-nums">
      <div className={tone}>
        {value > 0 ? '+' : ''}
        {value.toFixed(1)}%
      </div>
      <div className={cn('text-[9px]', alphaTone)}>
        alpha {alpha === null ? '-' : `${alpha >= 0 ? '+' : ''}${alpha.toFixed(1)}%`}
      </div>
    </td>
  );
}

function ExchangeBadge({ row }: { row: CompareRow }): React.ReactElement {
  const isCa = isCanadianListing(row);
  const flag = isCa ? '🇨🇦' : '🇺🇸';
  const title = isCa ? `${canadianExchangeName(row)} (CAD)` : 'US listing (USD)';
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

function OwnGlyph({ held }: { held: boolean }): React.ReactElement {
  return (
    <span
      title={held ? 'owned' : 'not held'}
      aria-label={held ? 'owned' : 'not held'}
      className={cn(
        'inline-flex size-2.5 rounded-full',
        held ? 'bg-[var(--cc-accent)] shadow-[0_0_6px_var(--cc-accent)]' : 'border border-white/30',
      )}
    />
  );
}

function ScoreBar({ score }: { score: number }): React.ReactElement {
  const width = 60;
  const clamped = Math.max(-1, Math.min(10, score));
  const magnitude = Math.max(1, (Math.abs(clamped) / 10) * width);
  const tone = clamped >= 0 ? 'bg-emerald-400' : 'bg-rose-400';
  return (
    <div
      className="relative hidden h-1.5 rounded-full bg-white/[0.06] sm:block"
      style={{ width: `${width}px` }}
      title={`lens score ${score.toFixed(2)} / 10`}
    >
      <div
        className={cn('absolute top-0 h-full rounded-full', tone)}
        style={{ left: 0, width: `${magnitude}px` }}
      />
    </div>
  );
}

function SignalBars({
  breakdown,
  weights,
}: {
  breakdown: SignalBreakdown | null;
  weights: DiscoveryWeights;
}): React.ReactElement {
  if (!breakdown) {
    return <span className="font-mono text-[10px] text-muted-foreground/60">—</span>;
  }
  return (
    <div
      className="flex items-end gap-0.5"
      title={SIGNAL_KEYS.map(
        (key) =>
          `${prettySignalName(key)}: ${breakdown[key].toFixed(2)} · weight ${(weights[key] * 100).toFixed(0)}%`,
      ).join(' · ')}
    >
      {SIGNAL_KEYS.map((k) => {
        const { min, max } = SIGNAL_RANGES[k];
        const raw = breakdown[k];
        const span = max - min;
        const norm = span > 0 ? (raw - min) / span : 0;
        const height = Math.max(4, Math.min(24, Math.round(norm * 24)));
        const tone = raw > 0 ? 'bg-emerald-400/80' : raw < 0 ? 'bg-rose-400/70' : 'bg-white/40';
        return (
          <span
            key={k}
            title={`${prettySignalName(k)} ${raw.toFixed(2)} · ${(weights[k] * 100).toFixed(0)}% weight`}
            aria-label={`${prettySignalName(k)}, ${raw.toFixed(2)}, ${(weights[k] * 100).toFixed(0)} percent weight`}
            className={cn('w-1 rounded-sm', tone)}
            style={{ height: `${height}px` }}
          />
        );
      })}
    </div>
  );
}

/**
 * Verdict pill. Frosted-glass styling with an accent hue per tone. The tone
 * comes from the pure verdict function so CompareTable and SwapPanel stay in
 * sync on color + label.
 */
const VERDICT_TONE_CLASSES: Record<VerdictTone, string> = {
  emerald:
    'border-emerald-500/40 bg-emerald-500/10 text-emerald-300 shadow-[inset_0_0_0_1px_rgba(16,185,129,0.1)]',
  amber:
    'border-amber-500/40 bg-amber-500/10 text-amber-300 shadow-[inset_0_0_0_1px_rgba(245,158,11,0.1)]',
  rose: 'border-rose-500/40 bg-rose-500/10 text-rose-300 shadow-[inset_0_0_0_1px_rgba(244,63,94,0.1)]',
  zinc: 'border-white/15 bg-white/[0.04] text-foreground/75',
};

export function VerdictPill({
  verdict,
  size = 'sm',
}: {
  verdict: Verdict;
  size?: 'sm' | 'md';
}): React.ReactElement {
  const sizeClass =
    size === 'md'
      ? 'px-2.5 py-1 text-[11px] tracking-[0.18em]'
      : 'px-2 py-0.5 text-[10px] tracking-[0.2em]';
  return (
    <span
      title={verdict.rationale}
      className={cn(
        'inline-flex items-center rounded-full border font-mono uppercase backdrop-blur-sm transition',
        sizeClass,
        VERDICT_TONE_CLASSES[verdict.tone],
      )}
    >
      {verdict.kind}
    </span>
  );
}

function ThesisBadge({ status }: { status: ThesisStatus | null }): React.ReactElement {
  if (!status) {
    return (
      <span className="rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground/70">
        no thesis
      </span>
    );
  }
  const toneMap: Record<ThesisStatus, string> = {
    Intact: 'border-white/15 bg-white/[0.04] text-foreground/70',
    Strengthening: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
    Weakening: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
    Broken: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
  };
  return (
    <span
      className={cn(
        'rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.2em]',
        toneMap[status],
      )}
    >
      {status}
    </span>
  );
}
