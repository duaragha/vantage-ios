'use client';

import * as React from 'react';
import { torontoTradingDaysBetween } from '@/lib/marketTime';
import { fmtDollarVolume, fmtEtClockTime } from '@/lib/format';

type TradingStyle = 'Momentum' | 'Breakout' | 'ORB' | 'MeanReversion' | 'Scalping';
/** Mirror of core's PriceSession union. */
type PriceSession = 'live' | 'premarket' | 'afterhours' | 'close' | 'prior-close';

/** Mirror of core's TradePlan, serialized for the client. */
export interface TradePlanRow {
  anchor: number;
  entryCondition: string;
  entry: number;
  stop: number;
  stopDistance: number;
  stopPct: number;
  stopAtrMult: number;
  target: number;
  rewardRiskRatio: number;
  shares: number;
  positionValue: number;
  riskPerTrade: number;
  dollarRisk: number;
  capital: number;
  nativeToCadRate: number;
}

export interface DayTradeCandidateRow {
  ticker: string;
  name: string | null;
  lastClose: number | null;
  currency: 'CAD' | 'USD';
  atrPct: number | null;
  relativeVolume: number | null;
  avgDollarVolume: number | null;
  beta: number | null;
  recentCatalyst: string | null;
  fitScore: number;
  reason: string;
  /** ISO date of the latest end-of-day bar this row was computed from. */
  asOf?: string | null;
  /** Live price (fresh Alpaca trade) when present; null falls back to lastClose. */
  livePrice?: number | null;
  /** Today's % move (live vs latest EOD close) when a live price exists. */
  liveChangePct?: number | null;
  /** ISO timestamp of the live price ("as of"). */
  liveAsOf?: string | null;
  /** Freshest real price the scanner holds (Fix 2/3) — prefer this for display. */
  displayPrice?: number | null;
  /** Which session displayPrice is from (live / premarket / afterhours / close / prior-close). */
  priceSession?: PriceSession | null;
  /** ISO timestamp of displayPrice ("as of"); a daily-bar date for prior-close. */
  displayAsOf?: string | null;
  /** Today's % move of displayPrice vs the right base (prior close). */
  displayChangePct?: number | null;
  /** ATR in dollars at the displayed price: atrPct/100 × displayPrice (Fix 1). */
  atrDollars?: number | null;
  /** Computed, rules-based trade plan. Null when the math can't be formed. */
  plan?: TradePlanRow | null;
}

type SortKey = 'fitScore' | 'atrPct' | 'relativeVolume' | 'avgDollarVolume' | 'ticker';

const num = (v: number | null, digits = 2) => (v === null ? '—' : v.toFixed(digits));
const money = (v: number | null, currency: 'CAD' | 'USD') =>
  v === null
    ? '—'
    : (currency === 'CAD' ? 'C$' : '$') + v.toLocaleString('en-CA', { maximumFractionDigits: 2 });
// Plain 2-dp dollar string for plan levels (entry/stop/target) — always cents.
const px = (v: number, currency: 'CAD' | 'USD') =>
  (currency === 'CAD' ? 'C$' : '$') +
  v.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signedPct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;

// Short, honest session label for the displayed price. "Live" gets the green dot
// elsewhere; the others state WHICH session the price is from so an hours-old
// after-hours print is never implied to be live.
const SESSION_LABEL: Record<PriceSession, string> = {
  live: 'live',
  premarket: 'pre-market',
  afterhours: 'after-hours',
  close: 'close',
  'prior-close': 'prior close',
};
// Tone per session: live = emerald (real-time), pre/after = amber (extended,
// thinner), close/prior-close = zinc (settled / stale).
const SESSION_TONE: Record<PriceSession, string> = {
  live: 'text-emerald-400',
  premarket: 'text-amber-300',
  afterhours: 'text-amber-300',
  close: 'text-zinc-400',
  'prior-close': 'text-zinc-500',
};

// "ATR 5.9% (≈$0.39)" — ATR% with its dollar value at the reference price (Fix 1).
function fmtAtr(
  atrPct: number | null,
  atrDollars: number | null | undefined,
  currency: 'CAD' | 'USD',
): string {
  if (atrPct === null) return '—';
  const pct = `${atrPct.toFixed(1)}%`;
  if (atrDollars == null || !Number.isFinite(atrDollars)) return pct;
  return `${pct} (≈${px(atrDollars, currency)})`;
}

// Color the ATR% and RVOL cells so a busy table reads at a glance: hotter
// (more volatile / more relative volume) = warmer color.
function atrTone(v: number | null): string {
  if (v === null) return 'text-zinc-500';
  if (v >= 8) return 'text-rose-300';
  if (v >= 4) return 'text-amber-300';
  return 'text-zinc-300';
}
function rvolTone(v: number | null): string {
  if (v === null) return 'text-zinc-500';
  if (v >= 3) return 'text-rose-300';
  if (v >= 1.5) return 'text-amber-300';
  return 'text-zinc-300';
}

// Fit ceilings differ markedly by style on the same universe (Momentum tops
// ~85, MeanReversion ~50), so a single 75/50 threshold paints whole styles
// uniformly weak. Color relative to each style's realistic top instead, so
// "strong/medium/weak" means the same thing within every style. [green, amber]
// cutoffs per style; below amber = weak.
const FIT_CUTOFFS: Record<TradingStyle, [number, number]> = {
  Momentum: [70, 45],
  Breakout: [60, 38],
  ORB: [75, 50],
  MeanReversion: [42, 28],
  Scalping: [70, 45],
};
function fitTone(v: number, style: TradingStyle | null): string {
  const [green, amber] = style ? FIT_CUTOFFS[style] : [75, 50];
  if (v >= green) return 'text-emerald-300';
  if (v >= amber) return 'text-amber-300';
  return 'text-zinc-400';
}

const dayFmt = (iso: string) =>
  new Date(iso + (iso.length === 10 ? 'T00:00:00' : '')).toLocaleDateString('en-CA', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

const easternTimestampDayFmt = (value: string | number | Date) => {
  const date =
    value instanceof Date ? value : typeof value === 'number' ? new Date(value) : new Date(value);
  return date.toLocaleDateString('en-CA', {
    timeZone: 'America/Toronto',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
};

// The per-candidate trade plan: the prescriptive core of the scanner. Stop and
// size are the loudest cells (they cap the loss); entry + target frame the
// trade. Every number is computed (ATR + recent bars + the 1%-risk rule), not a
// prediction — the copy says so.
function TradePlanBlock({ c }: { c: DayTradeCandidateRow }): React.ReactElement {
  const p = c.plan ?? null;
  if (!p) {
    return (
      <div className="text-xs text-zinc-500">
        No trade plan — insufficient recent data to compute ATR-based levels for {c.ticker}.
      </div>
    );
  }
  const cur = c.currency;
  const perShareRiskCad = p.stopDistance * p.nativeToCadRate;
  // Honest anchor label: the price the plan hangs off, by its session (live /
  // after-hours / close / prior close), not a blunt "(live)/(last close)".
  const anchorSession: PriceSession | null =
    c.priceSession ?? (c.livePrice != null ? 'live' : 'prior-close');
  const anchorLabel = anchorSession ? SESSION_LABEL[anchorSession] : 'last close';
  return (
    <div className="rounded-md border border-white/[0.06] bg-zinc-950/40 p-3">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-2 text-[11px] text-zinc-500">
        <span className="font-medium uppercase tracking-wider text-zinc-400">Trade plan</span>
        <span>
          · anchored to {px(p.anchor, cur)} ({anchorLabel})
        </span>
        <span>
          · {p.rewardRiskRatio}:1 reward:risk · stop = {p.stopAtrMult}× ATR
        </span>
        {/* ATR% with its $ value at the anchor (Fix 1) — the literal range size
            the stop/target are built from. */}
        {c.atrPct != null ? <span>· ATR {fmtAtr(c.atrPct, c.atrDollars, cur)}</span> : null}
      </div>

      {/* Stop + Size are the most prominent — they're what protects the account. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded border border-white/[0.06] bg-zinc-900/40 p-2">
          <div className="text-[10px] uppercase tracking-wider text-zinc-500">Entry</div>
          <div className="font-mono text-sm text-zinc-100">{px(p.entry, cur)}</div>
          <div className="mt-0.5 text-[10px] leading-snug text-zinc-500">{c.currency}</div>
        </div>
        <div className="rounded border border-rose-500/40 bg-rose-500/[0.08] p-2">
          <div className="text-[10px] uppercase tracking-wider text-rose-300">Hard stop</div>
          <div className="font-mono text-sm font-semibold text-rose-200">{px(p.stop, cur)}</div>
          <div className="mt-0.5 text-[10px] leading-snug text-rose-300/90">
            −{px(p.stopDistance, cur)} (−{p.stopPct.toFixed(1)}%)
          </div>
        </div>
        <div className="rounded border border-emerald-500/30 bg-emerald-500/[0.06] p-2">
          <div className="text-[10px] uppercase tracking-wider text-emerald-300">
            Target (+{p.rewardRiskRatio}R)
          </div>
          <div className="font-mono text-sm text-emerald-200">{px(p.target, cur)}</div>
          <div className="mt-0.5 text-[10px] leading-snug text-emerald-300/80">
            +{px(p.target - p.entry, cur)}
          </div>
        </div>
        <div className="rounded border border-sky-500/30 bg-sky-500/[0.06] p-2">
          <div className="text-[10px] uppercase tracking-wider text-sky-300">Size (1% risk)</div>
          <div className="font-mono text-sm font-semibold text-sky-100">
            {p.shares > 0 ? `${p.shares} sh` : '0 sh'}
          </div>
          <div className="mt-0.5 text-[10px] leading-snug text-sky-300/80">
            ≈ {px(p.positionValue, 'CAD')} · risk {px(p.dollarRisk, 'CAD')}
          </div>
        </div>
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-zinc-400">
        <span className="font-medium text-zinc-300">{p.entryCondition}.</span> Risk{' '}
        {px(p.riskPerTrade, 'CAD')} (1% of {px(p.capital, 'CAD')}) ÷ {px(perShareRiskCad, 'CAD')}{' '}
        risk per share ({px(p.stopDistance, cur)} stop) ={' '}
        {p.shares > 0 ? `${p.shares} shares` : 'less than 1 share at this risk'}. If the stop fills
        you lose ~{px(p.dollarRisk, 'CAD')}; honoring it is non-negotiable.
      </p>
      {p.shares === 0 ? (
        <p className="mt-1 text-[11px] leading-relaxed text-amber-300/90">
          A single share&apos;s stop risk ({px(perShareRiskCad, 'CAD')}) exceeds your 1% budget (
          {px(p.riskPerTrade, 'CAD')}) — this name is too pricey/volatile to size to 1% with this
          capital. Skip it or widen risk deliberately.
        </p>
      ) : null}
      {cur === 'USD' ? (
        <p className="mt-1 text-[10px] leading-relaxed text-zinc-600">
          USD levels are converted at 1 USD = C${p.nativeToCadRate.toFixed(4)} for exact CAD risk
          sizing.
        </p>
      ) : null}
    </div>
  );
}

export function DayTradeScannerTable({
  candidates,
  style = null,
}: {
  candidates: DayTradeCandidateRow[];
  style?: TradingStyle | null;
}): React.ReactElement {
  const [sortKey, setSortKey] = React.useState<SortKey>('fitScore');
  const [asc, setAsc] = React.useState(false);
  // Which candidate's trade plan is expanded (ticker), or null.
  const [openTicker, setOpenTicker] = React.useState<string | null>(null);

  // Whether any candidate carries a fresh (regular-hours, <10 min) LIVE price —
  // drives the green-dot framing in the price note.
  const hasAnyLive = React.useMemo(() => candidates.some((c) => c.livePrice != null), [candidates]);
  // Whether any candidate has a recent price from TODAY's session (live / pre /
  // after-hours / close) — i.e. a same-day real print, not just an old bar.
  const hasRecentPrice = React.useMemo(
    () =>
      candidates.some(
        (c) => c.priceSession != null && c.priceSession !== 'prior-close' && c.displayPrice != null,
      ),
    [candidates],
  );

  // Freshest ATR%/RVOL as-of (daily-bar date) across candidates. Volatility is a
  // legitimately DAILY measure, so a lagging EOD bar is expected — this drives an
  // INFORMATIONAL note, separate from price staleness below.
  const freshestBar = React.useMemo(() => {
    let max: number | null = null;
    for (const c of candidates) {
      if (!c.asOf) continue;
      const t = new Date(c.asOf + (c.asOf.length === 10 ? 'T00:00:00' : '')).getTime();
      if (!Number.isNaN(t) && (max === null || t > max)) max = t;
    }
    return max;
  }, [candidates]);

  // Freshest displayed-PRICE instant across candidates → drives TRUE price
  // staleness. A valid same-day after-hours/close price is NOT stale even though
  // the EOD bar lags; the banner only fires loud when the freshest PRICE we hold
  // is itself > 1 trading day old (markets long closed and no recent print).
  const freshestPrice = React.useMemo(() => {
    let max: number | null = null;
    for (const c of candidates) {
      if (!c.displayAsOf) continue;
      const iso = c.displayAsOf;
      const t = new Date(iso + (iso.length === 10 ? 'T00:00:00' : '')).getTime();
      if (!Number.isNaN(t) && (max === null || t > max)) max = t;
    }
    return max;
  }, [candidates]);
  const priceStaleTradingDays =
    freshestPrice !== null ? torontoTradingDaysBetween(new Date(freshestPrice), new Date()) : null;
  // Uneven staleness: some rows' prices older than the freshest price.
  const hasUneven = React.useMemo(() => {
    if (freshestPrice === null) return false;
    return candidates.some((c) => {
      if (!c.displayAsOf) return false;
      const iso = c.displayAsOf;
      const t = new Date(iso + (iso.length === 10 ? 'T00:00:00' : '')).getTime();
      return !Number.isNaN(t) && t < freshestPrice;
    });
  }, [candidates, freshestPrice]);

  const sorted = React.useMemo(() => {
    const rows = [...candidates];
    rows.sort((a, b) => {
      let cmp: number;
      if (sortKey === 'ticker') {
        cmp = a.ticker.localeCompare(b.ticker);
      } else {
        const av = (a[sortKey] as number | null) ?? -Infinity;
        const bv = (b[sortKey] as number | null) ?? -Infinity;
        cmp = av - bv;
      }
      return asc ? cmp : -cmp;
    });
    return rows;
  }, [candidates, sortKey, asc]);

  function toggle(key: SortKey) {
    if (key === sortKey) setAsc((a) => !a);
    else {
      setSortKey(key);
      setAsc(key === 'ticker');
    }
  }

  const arrow = (key: SortKey) => (key === sortKey ? (asc ? ' ↑' : ' ↓') : '');

  const sortLabel: Record<SortKey, string> = {
    fitScore: 'Fit score',
    atrPct: 'ATR%',
    relativeVolume: 'Relative volume',
    avgDollarVolume: 'Dollar volume',
    ticker: 'Ticker',
  };

  if (candidates.length === 0) {
    return (
      <div className="text-sm text-zinc-500">
        No candidates cleared the liquidity ($5M/day) and volatility (ATR ≥ 2%) floors in the latest
        end-of-day data.
      </div>
    );
  }

  // TRUE price staleness: the freshest PRICE we hold is itself > 1 trading day
  // old (markets long closed, no recent live/pre/after/close print). Does NOT
  // fire merely because it's after hours with a valid same-day price.
  const isPriceStale =
    priceStaleTradingDays !== null && priceStaleTradingDays > 1 && !hasRecentPrice;
  // ATR%/RVOL EOD bar lagging behind the price (the common, expected case) — an
  // informational note, not an alarm, shown only when a recent price exists.
  const barLags =
    !isPriceStale &&
    freshestBar !== null &&
    torontoTradingDaysBetween(new Date(freshestBar), new Date()) > 1;

  return (
    <div>
      {isPriceStale ? (
        <div className="mb-3 rounded border border-amber-500/40 bg-amber-500/[0.08] p-2.5 text-xs leading-relaxed text-amber-200">
          <span className="font-semibold">
            Stale prices — freshest is{' '}
            {freshestPrice !== null ? easternTimestampDayFmt(freshestPrice) : '—'}
            {', '}
            {priceStaleTradingDays} trading {priceStaleTradingDays === 1 ? 'day' : 'days'} old.
          </span>{' '}
          The market&apos;s been closed and no recent live, pre-market, or after-hours print is
          available — these prices and ATR%/RVOL are end-of-day and not actionable as live.
          Re-validate the tape before trading.
          {hasUneven ? ' Staleness is uneven across names (see the As of column).' : ''}
        </div>
      ) : barLags ? (
        <div className="mb-3 rounded border border-white/[0.08] bg-zinc-500/[0.06] p-2.5 text-xs leading-relaxed text-zinc-300">
          <span className="font-medium text-zinc-200">
            ATR% / RVOL as of{' '}
            {freshestBar !== null ? dayFmt(new Date(freshestBar).toISOString().slice(0, 10)) : '—'}
            {' (end-of-day).'}
          </span>{' '}
          The displayed price is session-tagged and current
          {hasAnyLive ? ' (some names are live now)' : ''}, but volatility/relative-volume are daily
          measures, so an end-of-day bar is expected — not a bug. Re-validate the live tape before
          trading.
          {hasUneven ? ' Price staleness is uneven across names (see the As of column).' : ''}
        </div>
      ) : null}
      <p className="mb-2 text-[11px] leading-relaxed text-zinc-500">
        Tap a row to see its trade plan — entry trigger, hard stop, target, and a share count sized
        to risk ~1% of this goal&apos;s capital. The price is always the freshest real print we
        hold, tagged by session — <span className="text-emerald-400">live</span> (green dot) during
        regular hours, else <span className="text-amber-300">pre-market</span> /{' '}
        <span className="text-amber-300">after-hours</span> / close — stamped in ET (Alpaca, IEX).
        ATR% (with its $ value) and RVOL are daily-derived.
      </p>
      <div className="mb-3 flex items-end gap-2 md:hidden">
        <label className="min-w-0 flex-1 text-[10px] uppercase tracking-wider text-zinc-500">
          Sort candidates
          <select
            value={sortKey}
            onChange={(event) => toggle(event.target.value as SortKey)}
            className="mt-1 min-h-11 w-full rounded border border-white/[0.08] bg-zinc-950 px-3 text-sm normal-case tracking-normal text-zinc-200 outline-none focus:border-emerald-500/50"
          >
            {(Object.keys(sortLabel) as SortKey[]).map((key) => (
              <option key={key} value={key}>
                {sortLabel[key]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => setAsc((value) => !value)}
          className="min-h-11 shrink-0 rounded border border-white/[0.08] px-3 text-xs text-zinc-300 hover:bg-white/[0.04]"
          aria-label={`Sort ${asc ? 'descending' : 'ascending'}`}
        >
          {asc ? '↑ Asc' : '↓ Desc'}
        </button>
      </div>

      <div className="space-y-3 md:hidden">
        {sorted.map((c) => {
          const session: PriceSession | null =
            c.priceSession ??
            (c.livePrice != null ? 'live' : c.lastClose != null ? 'prior-close' : null);
          const displayPrice = c.displayPrice ?? (c.livePrice != null ? c.livePrice : c.lastClose);
          const changePct = c.displayChangePct ?? c.liveChangePct ?? null;
          const isLive = session === 'live';
          const rowStale =
            c.displayAsOf != null &&
            freshestPrice !== null &&
            new Date(c.displayAsOf + (c.displayAsOf.length === 10 ? 'T00:00:00' : '')).getTime() <
              freshestPrice;
          const open = c.ticker === openTicker;
          const asOf =
            session !== null && session !== 'prior-close' && c.displayAsOf
              ? fmtEtClockTime(c.displayAsOf)
              : c.displayAsOf
                ? dayFmt(c.displayAsOf)
                : c.asOf
                  ? dayFmt(c.asOf)
                  : '—';

          return (
            <article
              key={c.ticker}
              className="rounded-lg border border-white/[0.06] bg-zinc-950/30 p-4"
            >
              <button
                type="button"
                onClick={() => setOpenTicker(open ? null : c.ticker)}
                className="flex min-h-11 w-full min-w-0 items-start justify-between gap-3 text-left"
                aria-expanded={open}
              >
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-base font-semibold text-zinc-100">
                      {c.ticker}
                    </span>
                    <span className="text-[10px] uppercase tracking-wider text-zinc-600">
                      {c.currency}
                    </span>
                  </span>
                  <span className="mt-0.5 block break-words text-xs text-zinc-400">
                    {c.name ?? '—'}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2 pt-0.5">
                  <span className={'font-mono text-sm ' + fitTone(c.fitScore, style)}>
                    {c.fitScore}/100
                  </span>
                  <span className="text-zinc-500" aria-hidden="true">
                    {open ? '▾' : '▸'}
                  </span>
                </span>
              </button>

              <p className="mt-2 break-words text-xs leading-relaxed text-zinc-500">{c.reason}</p>

              <dl className="mt-4 grid grid-cols-2 gap-3 text-xs">
                <div className="rounded border border-white/[0.05] bg-white/[0.02] p-2.5">
                  <dt className="text-[10px] uppercase tracking-wider text-zinc-500">
                    Price / today
                  </dt>
                  <dd className="mt-1 font-mono">
                    <span className="flex items-center gap-1.5">
                      {isLive ? (
                        <span
                          className="size-1.5 rounded-full bg-emerald-400"
                          title="Live price (Alpaca, IEX), regular hours, under 10 minutes old"
                        />
                      ) : null}
                      <span className={isLive ? 'text-zinc-100' : 'text-zinc-300'}>
                        {money(displayPrice, c.currency)}
                      </span>
                    </span>
                    <span className="mt-0.5 block text-[11px]">
                      {session !== null ? (
                        <span className={SESSION_TONE[session]}>{SESSION_LABEL[session]}</span>
                      ) : null}
                      {changePct != null && session !== 'prior-close' ? (
                        <span className={changePct >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                          {' · '}
                          {signedPct(changePct)}
                        </span>
                      ) : null}
                    </span>
                  </dd>
                </div>
                <div className="rounded border border-white/[0.05] bg-white/[0.02] p-2.5">
                  <dt className="text-[10px] uppercase tracking-wider text-zinc-500">As of</dt>
                  <dd
                    className={
                      'mt-1 break-words font-mono text-[11px] ' +
                      (isLive
                        ? 'text-emerald-400'
                        : rowStale
                          ? 'text-amber-300'
                          : session !== null && session !== 'prior-close'
                            ? 'text-zinc-400'
                            : 'text-zinc-500')
                    }
                  >
                    {asOf}
                  </dd>
                </div>
                <div>
                  <dt className="text-[10px] uppercase tracking-wider text-zinc-500">ATR</dt>
                  <dd className={'mt-1 font-mono ' + atrTone(c.atrPct)}>
                    {fmtAtr(c.atrPct, c.atrDollars, c.currency)}
                  </dd>
                </div>
                <div>
                  <dt className="text-[10px] uppercase tracking-wider text-zinc-500">RVOL</dt>
                  <dd className={'mt-1 font-mono ' + rvolTone(c.relativeVolume)}>
                    {num(c.relativeVolume, 1)}x
                  </dd>
                </div>
                <div>
                  <dt className="text-[10px] uppercase tracking-wider text-zinc-500">
                    Dollar volume
                  </dt>
                  <dd className="mt-1 font-mono text-zinc-300">
                    {fmtDollarVolume(c.avgDollarVolume, c.currency)}
                  </dd>
                </div>
                <div>
                  <dt className="text-[10px] uppercase tracking-wider text-zinc-500">Fit</dt>
                  <dd className={'mt-1 font-mono ' + fitTone(c.fitScore, style)}>
                    {c.fitScore}/100
                  </dd>
                </div>
                <div className="col-span-2 border-t border-white/[0.05] pt-3">
                  <dt className="text-[10px] uppercase tracking-wider text-zinc-500">Catalyst</dt>
                  <dd className="mt-1 break-words leading-relaxed text-zinc-400">
                    {c.recentCatalyst ?? '—'}
                  </dd>
                </div>
              </dl>

              {open ? (
                <div className="mt-4 border-t border-white/[0.06] pt-4">
                  <TradePlanBlock c={c} />
                </div>
              ) : null}
            </article>
          );
        })}
      </div>

      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-zinc-500">
            <tr>
              <th
                className="cursor-pointer pb-2 hover:text-zinc-300"
                onClick={() => toggle('ticker')}
              >
                Ticker{arrow('ticker')}
              </th>
              <th className="pb-2">Name</th>
              <th className="pb-2 text-right">Price / today</th>
              <th
                className="cursor-pointer pb-2 text-right hover:text-zinc-300"
                onClick={() => toggle('atrPct')}
              >
                ATR%{arrow('atrPct')}
              </th>
              <th
                className="cursor-pointer pb-2 text-right hover:text-zinc-300"
                onClick={() => toggle('relativeVolume')}
              >
                RVOL{arrow('relativeVolume')}
              </th>
              <th
                className="cursor-pointer pb-2 text-right hover:text-zinc-300"
                onClick={() => toggle('avgDollarVolume')}
              >
                $-vol{arrow('avgDollarVolume')}
              </th>
              {/* pl-4 separates the right-aligned $-vol number from the
                  left-aligned catalyst text — without it they jam ("$324M8-K"). */}
              <th className="pb-2 pl-4">Catalyst</th>
              <th className="pb-2 text-right">As of</th>
              <th
                className="cursor-pointer pb-2 text-right hover:text-zinc-300"
                onClick={() => toggle('fitScore')}
                title="Fit is relative within the selected style; scores are not comparable across styles."
              >
                Fit{arrow('fitScore')}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.04]">
            {sorted.map((c) => {
              // Freshest displayed price + its honest session (Fix 2/3). Fall
              // back to the legacy live/lastClose shape if the new fields aren't
              // present (e.g. a transient pre-redeploy payload).
              const session: PriceSession | null =
                c.priceSession ??
                (c.livePrice != null ? 'live' : c.lastClose != null ? 'prior-close' : null);
              const displayPrice =
                c.displayPrice ?? (c.livePrice != null ? c.livePrice : c.lastClose);
              const changePct = c.displayChangePct ?? c.liveChangePct ?? null;
              const isLive = session === 'live';
              // Row "price stale" = this row's displayed price is older than the
              // freshest price we hold across the table.
              const rowStale =
                c.displayAsOf != null &&
                freshestPrice !== null &&
                new Date(
                  c.displayAsOf + (c.displayAsOf.length === 10 ? 'T00:00:00' : ''),
                ).getTime() < freshestPrice;
              const open = c.ticker === openTicker;
              return (
                <React.Fragment key={c.ticker}>
                  <tr
                    className="cursor-pointer align-top hover:bg-white/[0.02]"
                    onClick={() => setOpenTicker(open ? null : c.ticker)}
                  >
                    <td className="py-2 font-mono font-medium">
                      <span className="mr-1 inline-block text-zinc-600">{open ? '▾' : '▸'}</span>
                      {c.ticker}
                      <span className="ml-1 text-[10px] uppercase tracking-wider text-zinc-600">
                        {c.currency}
                      </span>
                    </td>
                    <td
                      className="max-w-[14rem] truncate py-2 text-xs text-zinc-400"
                      title={c.name ?? ''}
                    >
                      {c.name ?? '—'}
                      <div className="text-[11px] text-zinc-500">{c.reason}</div>
                    </td>
                    <td className="py-2 text-right font-mono text-xs">
                      <div className="flex items-center justify-end gap-1.5">
                        {isLive ? (
                          <span
                            className="size-1.5 rounded-full bg-emerald-400"
                            title="Live price (Alpaca, IEX) — regular hours, < 10 min old"
                          />
                        ) : null}
                        <span className={isLive ? 'text-zinc-100' : 'text-zinc-300'}>
                          {money(displayPrice, c.currency)}
                        </span>
                      </div>
                      {/* Session label + today's move. The label is the honest
                          "which session" tag; never implies "live" off-hours. */}
                      <div className="text-[11px]">
                        {session !== null ? (
                          <span className={SESSION_TONE[session]}>{SESSION_LABEL[session]}</span>
                        ) : null}
                        {changePct != null && session !== 'prior-close' ? (
                          <span className={changePct >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                            {' · '}
                            {signedPct(changePct)}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className={'py-2 text-right font-mono text-xs ' + atrTone(c.atrPct)}>
                      {fmtAtr(c.atrPct, c.atrDollars, c.currency)}
                    </td>
                    <td
                      className={'py-2 text-right font-mono text-xs ' + rvolTone(c.relativeVolume)}
                    >
                      {num(c.relativeVolume, 1)}x
                    </td>
                    <td className="whitespace-nowrap py-2 text-right font-mono text-xs text-zinc-300">
                      {fmtDollarVolume(c.avgDollarVolume, c.currency)}
                    </td>
                    {/* pl-4 matches the header — keeps a clear gap from $-vol. */}
                    <td className="py-2 pl-4 text-xs text-zinc-400">{c.recentCatalyst ?? '—'}</td>
                    <td
                      className={
                        'py-2 text-right font-mono text-[11px] ' +
                        (isLive
                          ? 'text-emerald-400'
                          : rowStale
                            ? 'text-amber-300'
                            : session !== null && session !== 'prior-close'
                              ? 'text-zinc-400'
                              : 'text-zinc-500')
                      }
                    >
                      {/* Session-stamped prints (live/pre/after/close) show the
                          actual ET trade time; a prior-close shows the bar date. */}
                      {session !== null && session !== 'prior-close' && c.displayAsOf
                        ? fmtEtClockTime(c.displayAsOf)
                        : c.displayAsOf
                          ? dayFmt(c.displayAsOf)
                          : c.asOf
                            ? dayFmt(c.asOf)
                            : '—'}
                    </td>
                    <td
                      className={'py-2 text-right font-mono text-xs ' + fitTone(c.fitScore, style)}
                    >
                      {c.fitScore}/100
                    </td>
                  </tr>
                  {open ? (
                    <tr className="bg-white/[0.015]">
                      <td colSpan={9} className="px-3 pb-4 pt-1">
                        <TradePlanBlock c={c} />
                      </td>
                    </tr>
                  ) : null}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
        Fit is relative within the selected style — a Mean-Reversion 50 and a Momentum 85 are both
        strong for their style; scores don&apos;t compare across styles. Trade-plan levels are
        computed from ATR + recent bars + the 1%-risk rule, not forecasts. Single-stock
        option-income ETFs (YieldMax-style) are filtered out even here for their NAV-erosion risk.
      </p>
    </div>
  );
}
