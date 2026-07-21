/**
 * SwapPanel — renders the best held-vs-candidate pairs.
 *
 * For each pair, two side-by-side cards (TRIM rose / BUY emerald) with the
 * scores, a deterministic "why" paragraph, and a button to record the
 * rotation as an Insight. Status gating is advisory only — the page shows
 * pairs even when the thesis is Intact so the user always sees the
 * comparison.
 */

'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { FrostedPanel } from '@/components/FrostedPanel';
import type { SwapPair } from './data';
import { acceptSwapAction } from './actions';
import { VerdictPill } from './CompareTable';

export function SwapPanel({
  swaps,
  heldCount,
}: {
  swaps: SwapPair[];
  heldCount: number;
}): React.ReactElement {
  if (heldCount === 0) {
    return (
      <FrostedPanel>
        <div className="py-6 text-center font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
          add a position to see rotation candidates
        </div>
      </FrostedPanel>
    );
  }

  if (swaps.length === 0) {
    return (
      <FrostedPanel>
        <div className="py-6 text-center font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          no candidate beats a held ticker by &ge; 0.30 right now
        </div>
      </FrostedPanel>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {swaps.map((s) => (
        <SwapCard key={`${s.trimTicker}->${s.buyTicker}`} swap={s} />
      ))}
    </div>
  );
}

function SwapCard({ swap }: { swap: SwapPair }): React.ReactElement {
  const [busy, setBusy] = React.useState(false);
  const [toast, setToast] = React.useState<string | null>(null);
  const [accepted, setAccepted] = React.useState(false);

  const onAccept = async () => {
    setBusy(true);
    setToast(null);
    const res = await acceptSwapAction({
      trimTicker: swap.trimTicker,
      buyTicker: swap.buyTicker,
      scoreDelta: swap.scoreDelta,
      why: swap.why,
    });
    setBusy(false);
    if (res.ok) {
      setAccepted(true);
      setToast(`Insight created (#${res.insightId ?? '?'})`);
    } else {
      setToast(res.error ?? 'failed');
    }
  };

  return (
    <div id={`swap-${anchorTicker(swap.trimTicker)}`} className="scroll-mt-6">
      <FrostedPanel padding="none">
        <div className="grid grid-cols-1 gap-0 lg:grid-cols-[1fr_auto_1fr]">
          {/* TRIM side */}
          <div className="relative flex flex-col gap-3 p-5">
            <span className="absolute left-0 top-5 h-6 w-0.5 rounded-r-full bg-rose-400/80" />
            <div className="flex items-baseline justify-between">
              <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-rose-300/80">
                trim
              </div>
              <div className="font-mono text-[10px] text-muted-foreground/70">
                {swap.trimSharesHeld !== null ? `${formatShares(swap.trimSharesHeld)} sh` : ''}
                {swap.trimValueUsd !== null
                  ? ` · $${swap.trimValueUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
                  : ''}
              </div>
            </div>
            <div className="flex items-baseline gap-3">
              <div className="font-mono text-xl font-semibold tabular-nums text-foreground">
                {swap.trimTicker}
              </div>
              {swap.trimName && (
                <div className="max-w-[14rem] truncate text-sm text-muted-foreground">
                  {swap.trimName}
                </div>
              )}
            </div>
            <div className="flex items-baseline gap-4">
              <MetricRow
                label="score"
                value={signed(swap.trimScore)}
                tone={scoreTone(swap.trimScore)}
              />
              <MetricRow
                label="30d"
                value={
                  swap.trimThirtyDayReturnPct === null
                    ? '—'
                    : `${swap.trimThirtyDayReturnPct > 0 ? '+' : ''}${swap.trimThirtyDayReturnPct.toFixed(1)}%`
                }
                tone={
                  swap.trimThirtyDayReturnPct === null
                    ? 'text-muted-foreground'
                    : swap.trimThirtyDayReturnPct > 0
                      ? 'text-emerald-300'
                      : swap.trimThirtyDayReturnPct < 0
                        ? 'text-rose-300'
                        : 'text-foreground'
                }
              />
            </div>
            <ThesisLabel status={swap.trimThesisStatus} />
          </div>

          {/* Delta chevron — shows verdict transition (held side → candidate)
            so the panel reads like an action at a glance. */}
          <div className="flex flex-row items-center justify-center gap-3 border-y border-white/[0.06] px-6 py-3 lg:flex-col lg:gap-2 lg:border-x lg:border-y-0 lg:px-4">
            <div className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground/80">
              delta
            </div>
            <div
              className={cn(
                'font-mono text-2xl font-semibold tabular-nums',
                swap.scoreDelta >= swap.triggerThreshold
                  ? 'text-emerald-300'
                  : 'text-foreground/80',
              )}
            >
              +{swap.scoreDelta.toFixed(2)}
            </div>
            <div className="flex flex-row items-center gap-1.5 lg:flex-col lg:gap-1">
              <VerdictPill verdict={swap.trimVerdict} size="sm" />
              <span aria-hidden className="font-mono text-xs text-muted-foreground/70 lg:my-0.5">
                {/* Arrow: horizontal on mobile, vertical on desktop */}
                <span className="lg:hidden">→</span>
                <span className="hidden lg:inline">↓</span>
              </span>
              <VerdictPill verdict={swap.buyVerdict} size="sm" />
            </div>
          </div>

          {/* BUY side */}
          <div className="relative flex flex-col gap-3 p-5">
            <span className="absolute right-0 top-5 h-6 w-0.5 rounded-l-full bg-emerald-400/80" />
            <div className="flex items-baseline justify-between">
              <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-emerald-300/80">
                buy
              </div>
              <div className="font-mono text-[10px] text-muted-foreground/70">candidate</div>
            </div>
            <div className="flex items-baseline gap-3">
              <div className="font-mono text-xl font-semibold tabular-nums text-foreground">
                {swap.buyTicker}
              </div>
              {swap.buyName && (
                <div className="max-w-[14rem] truncate text-sm text-muted-foreground">
                  {swap.buyName}
                </div>
              )}
            </div>
            <div className="flex items-baseline gap-4">
              <MetricRow
                label="score"
                value={signed(swap.buyScore)}
                tone={scoreTone(swap.buyScore)}
              />
              <MetricRow
                label="30d"
                value={
                  swap.buyThirtyDayReturnPct === null
                    ? '—'
                    : `${swap.buyThirtyDayReturnPct > 0 ? '+' : ''}${swap.buyThirtyDayReturnPct.toFixed(1)}%`
                }
                tone={
                  swap.buyThirtyDayReturnPct === null
                    ? 'text-muted-foreground'
                    : swap.buyThirtyDayReturnPct > 0
                      ? 'text-emerald-300'
                      : swap.buyThirtyDayReturnPct < 0
                        ? 'text-rose-300'
                        : 'text-foreground'
                }
              />
            </div>
          </div>
        </div>

        <div className="border-t border-white/[0.06] px-5 py-4">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
            why
          </div>
          <p className="text-sm leading-relaxed text-foreground/85">{swap.why}</p>
          {!swap.wouldTrigger && (
            <p className="mt-1 text-xs text-muted-foreground">
              Not auto-emitted: needs delta &ge; {swap.triggerThreshold.toFixed(2)} AND held thesis
              Weakening/Broken (currently{' '}
              <span className="font-mono">{swap.trimThesisStatus ?? 'none'}</span>, delta{' '}
              {swap.scoreDelta.toFixed(2)}).
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-white/[0.06] px-5 py-3">
          <button
            type="button"
            onClick={onAccept}
            disabled={busy || accepted}
            className={cn(
              'rounded-md border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] transition disabled:opacity-40',
              accepted
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                : 'border-[var(--cc-accent)]/40 bg-[var(--cc-accent)]/10 text-[var(--cc-accent)] hover:bg-[var(--cc-accent)]/20',
            )}
          >
            {accepted ? 'Accepted' : busy ? '…' : 'Accept rotation'}
          </button>
          {toast && <div className="font-mono text-[10px] text-muted-foreground">{toast}</div>}
        </div>
      </FrostedPanel>
    </div>
  );
}

function MetricRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: string;
}): React.ReactElement {
  return (
    <div className="flex flex-col">
      <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground/80">
        {label}
      </span>
      <span className={cn('font-mono text-base tabular-nums', tone)}>{value}</span>
    </div>
  );
}

function ThesisLabel({ status }: { status: SwapPair['trimThesisStatus'] }): React.ReactElement {
  if (!status) {
    return (
      <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground/70">
        thesis: none
      </div>
    );
  }
  const toneMap: Record<NonNullable<SwapPair['trimThesisStatus']>, string> = {
    Intact: 'text-foreground/70',
    Strengthening: 'text-emerald-300',
    Weakening: 'text-amber-300',
    Broken: 'text-rose-300',
  };
  return (
    <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground/70">
      thesis: <span className={toneMap[status]}>{status.toLowerCase()}</span>
    </div>
  );
}

function signed(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;
}

function scoreTone(score: number): string {
  if (score >= 6) return 'text-emerald-300';
  if (score < 0) return 'text-rose-300';
  return 'text-foreground';
}

function formatShares(n: number): string {
  const abs = Math.abs(n);
  if (Math.floor(abs) === abs) return n.toLocaleString('en-US');
  return n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

function anchorTicker(ticker: string): string {
  return ticker.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}
