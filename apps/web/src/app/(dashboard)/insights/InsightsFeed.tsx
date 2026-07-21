/**
 * InsightsFeed — filter chips + motion-animated stream.
 */

'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'motion/react';
import {
  AlertTriangle,
  ArrowRightLeft,
  Clock3,
  FileText,
  FlaskConical,
  Microscope,
  Shuffle,
  Sparkles,
  Star,
  Target,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react';
import { FrostedPanel } from '@/components/FrostedPanel';
import { fmtMoney, fmtTimeAgo } from '@/lib/format';
import { isInsightActionable, type NormalizedInsightAction } from '@/lib/insightActions';
import { cn } from '@/lib/utils';

export interface InsightView {
  id: number;
  kind: string;
  title: string;
  body: string;
  reasoning: string;
  confidence: string;
  status: string;
  triggeredBy: string;
  createdAt: string;
  citations: Array<{ articleId: number | null; quote: string }>;
  action: NormalizedInsightAction | null;
  catalystDetails: string[];
}

const CATALYST_KIND_META: Record<string, { icon: LucideIcon; label: string }> = {
  InsiderCluster: { icon: Microscope, label: 'INSIDER CLUSTER' },
  EarningsBeat: { icon: TrendingUp, label: 'EARNINGS BEAT' },
  Material8K: { icon: FileText, label: 'MATERIAL 8-K' },
  AnalystUpgrade: { icon: Star, label: 'ANALYST UPGRADE' },
  mixed: { icon: FlaskConical, label: 'MIXED CATALYSTS' },
};

function isCatalystSuggestion(v: InsightView): boolean {
  if (v.kind !== 'BuySuggestion') return false;
  return Boolean(v.action?.catalystKind);
}

function remainingUrgencyMs(exp: string | null | undefined): number {
  if (!exp) return Number.POSITIVE_INFINITY;
  const t = new Date(exp).getTime();
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return t - Date.now();
}

function isRotation(v: InsightView): boolean {
  return v.kind === 'Rebalance' && v.action?.type === 'rotation';
}

type Filter = 'all' | 'Alert' | 'BuySuggestion' | 'Rebalance' | 'ThesisUpdate' | 'Catalyst';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'Alert', label: 'Alerts' },
  { key: 'BuySuggestion', label: 'Buys' },
  { key: 'Catalyst', label: 'Catalyst' },
  { key: 'Rebalance', label: 'Rebalance' },
  { key: 'ThesisUpdate', label: 'Thesis' },
];

export function InsightsFeed({ insights }: { insights: InsightView[] }): React.ReactElement {
  const [filter, setFilter] = React.useState<Filter>('all');
  const filtered = React.useMemo(() => {
    if (filter === 'all') return insights;
    if (filter === 'Catalyst') {
      const catalyst = insights.filter(isCatalystSuggestion);
      // Sort by conjunctionLevel desc, then urgency-remaining ASC.
      return [...catalyst].sort((a, b) => {
        const aLevel = a.action?.conjunctionLevel ?? 0;
        const bLevel = b.action?.conjunctionLevel ?? 0;
        if (bLevel !== aLevel) return bLevel - aLevel;
        const aMs = remainingUrgencyMs(a.action?.urgencyExpiresAt);
        const bMs = remainingUrgencyMs(b.action?.urgencyExpiresAt);
        // Closest-to-expiry first (smaller positive remaining → higher
        // priority). Expired items (negative) sink to the bottom.
        if (aMs <= 0 && bMs <= 0) return bMs - aMs;
        if (aMs <= 0) return 1;
        if (bMs <= 0) return -1;
        return aMs - bMs;
      });
    }
    return insights.filter((i) => i.kind === filter);
  }, [insights, filter]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={cn(
              'rounded-full border px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] transition',
              filter === f.key
                ? 'border-[var(--cc-accent)]/50 bg-[var(--cc-accent)]/10 text-[var(--cc-accent)]'
                : 'border-white/[0.08] text-muted-foreground hover:border-white/[0.2] hover:text-foreground',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <FrostedPanel padding="lg">
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
              No alerts today — good.
            </div>
            <p className="max-w-md text-sm text-muted-foreground">
              Nothing to action. The agent is quiet when your theses are intact and no catalysts
              broke today.
            </p>
          </div>
        </FrostedPanel>
      ) : (
        <AnimatePresence initial={false}>
          <div className="flex flex-col gap-3">
            {filtered.map((insight, i) => (
              <motion.div
                key={insight.id}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{
                  type: 'spring',
                  stiffness: 220,
                  damping: 26,
                  delay: Math.min(i, 6) * 0.03,
                }}
              >
                <InsightCard insight={insight} />
              </motion.div>
            ))}
          </div>
        </AnimatePresence>
      )}
    </div>
  );
}

function InsightCard({ insight }: { insight: InsightView }): React.ReactElement {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [status, setStatus] = React.useState(insight.status);
  const [toast, setToast] = React.useState<string | null>(null);

  const Icon = iconFor(insight);
  const rotation = isRotation(insight);
  const confidenceTone = CONFIDENCE_TONE[insight.confidence] ?? 'text-muted-foreground';

  const isActionable = isInsightActionable(insight.kind, status, insight.action);
  const noReplacement =
    insight.kind === 'Rebalance' &&
    insight.action?.type === 'rebalance' &&
    (insight.action.action === 'trim' || insight.action.action === 'exit') &&
    insight.action.replacementConsidered === true &&
    insight.action.replacementFound === false;
  const reviewPositionHref =
    insight.kind === 'ThesisUpdate' && insight.action?.ticker
      ? `/positions/${encodeURIComponent(insight.action.ticker)}${
          insight.action.positionId ? `?positionId=${insight.action.positionId}` : ''
        }`
      : null;

  const onBuy = () => {
    if (!insight.action?.ticker) return;
    const params = new URLSearchParams({
      fromInsight: String(insight.id),
      ticker: insight.action.ticker,
    });
    if (insight.action.shares !== null && insight.action.shares !== undefined) {
      params.set('shares', String(insight.action.shares));
    }
    if (insight.action.priceSnapshot !== null && insight.action.priceSnapshot !== undefined) {
      params.set('priceSnapshot', String(insight.action.priceSnapshot));
    }
    if (insight.action.priceCurrency) {
      params.set('currency', insight.action.priceCurrency);
    }
    // For rotations, pass the trim-side fields so the add-position page can
    // surface a follow-up confirm once the buy-side Position is saved.
    if (rotation && insight.action.trimTicker) {
      params.set('rotationTrimTicker', insight.action.trimTicker);
      if (insight.action.trimShares !== null && insight.action.trimShares !== undefined) {
        params.set('rotationTrimShares', String(insight.action.trimShares));
      }
    }
    router.push(`/portfolio/add?${params.toString()}`);
  };

  const onPass = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/insights/${insight.id}/pass`, {
        method: 'POST',
      });
      if (res.ok) {
        const data = (await res.json()) as {
          cooldownUntil?: string | null;
          ticker?: string | null;
        };
        setStatus('Passed');
        setToast(
          data?.cooldownUntil
            ? `Passed. ${data.ticker} on cooldown until ${new Date(data.cooldownUntil).toLocaleDateString()}.`
            : 'Passed.',
        );
      } else {
        setToast('Could not pass — try again.');
      }
    } catch {
      setToast('Network error.');
    } finally {
      setBusy(false);
    }
  };

  const catalystKind = insight.action?.catalystKind ?? null;
  const catalystMeta = catalystKind ? CATALYST_KIND_META[catalystKind] : null;
  const conjunctionLevel = insight.action?.conjunctionLevel ?? null;
  const urgencyExpiresAt = insight.action?.urgencyExpiresAt ?? null;
  const CatalystIcon = catalystMeta?.icon ?? null;

  return (
    <FrostedPanel padding="md" className="relative flex flex-col gap-3">
      {catalystMeta && (
        <div className="flex flex-col items-end gap-1 self-end sm:absolute sm:right-3 sm:top-3">
          <span className="rounded-full border border-[var(--cc-accent)]/40 bg-[var(--cc-accent)]/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.2em] text-[var(--cc-accent)]">
            {CatalystIcon && <CatalystIcon className="mr-1 inline size-3" aria-hidden />}
            {catalystMeta.label}
          </span>
          {conjunctionLevel !== null && <ConjunctionDots level={conjunctionLevel} />}
          {urgencyExpiresAt && <UrgencyTag expiresAt={urgencyExpiresAt} />}
        </div>
      )}
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-[var(--cc-accent)]/10 text-[var(--cc-accent)]">
          <Icon className="size-4" />
        </div>
        <div className="flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              {insight.kind}
            </span>
            <span
              className={cn(
                'rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.2em]',
                confidenceTone,
              )}
            >
              {insight.confidence}
            </span>
            {status !== 'New' && (
              <span className="rounded-full border border-white/[0.1] bg-white/[0.05] px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">
                {status}
              </span>
            )}
            <span className="w-full font-mono text-[10px] text-muted-foreground/70 sm:ml-auto sm:w-auto">
              {fmtTimeAgo(insight.createdAt)} · {insight.triggeredBy}
            </span>
          </div>
          <h3 className="mt-1 text-base font-semibold tracking-tight text-foreground">
            {insight.title}
          </h3>
          {rotation && insight.action ? (
            <RotationCard action={insight.action} body={insight.body} />
          ) : (
            <p className="mt-1 whitespace-pre-wrap text-sm text-foreground/80">{insight.body}</p>
          )}
          {insight.reasoning && insight.reasoning !== insight.body && (
            <p className="mt-2 text-xs italic text-muted-foreground/80">{insight.reasoning}</p>
          )}

          {insight.catalystDetails.length > 0 && (
            <div className="mt-3 border-l-2 border-[var(--cc-accent)]/40 pl-3">
              <div className="font-mono text-[9px] uppercase text-[var(--cc-accent)]/80">
                Event detail
              </div>
              <ul className="mt-1 space-y-1 text-xs leading-relaxed text-foreground/70">
                {insight.catalystDetails.map((detail) => (
                  <li key={detail}>{detail}</li>
                ))}
              </ul>
            </div>
          )}

          {noReplacement && insight.action && (
            <div className="mt-3 border-l-2 border-amber-400/60 pl-3 text-xs text-amber-100/80">
              <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-amber-300">
                replacement
              </span>
              <span className="ml-2">
                {insight.action.replacementNote ??
                  (insight.action.replacementState === 'source-unavailable'
                    ? 'Candidate data was unavailable. Refresh Discovery before treating this as a final one-sided decision.'
                    : 'No candidate cleared the goal fit, cooldown, account, sizing, and cap checks.')}
              </span>
            </div>
          )}

          {insight.citations.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {insight.citations.slice(0, 6).map((c, i) => (
                <details
                  key={`${c.articleId}-${i}`}
                  className="group max-w-full rounded-md border border-white/[0.08] bg-white/[0.03] text-muted-foreground"
                >
                  <summary className="max-w-[30ch] cursor-pointer list-none truncate px-2 py-1 font-mono text-[10px] marker:hidden">
                    src {c.articleId ?? '?'} · {c.quote.slice(0, 48)}
                    {c.quote.length > 48 ? '…' : ''}
                  </summary>
                  <p className="max-w-lg border-t border-white/[0.06] px-2 py-2 text-xs leading-relaxed text-foreground/75">
                    {c.quote}
                  </p>
                </details>
              ))}
            </div>
          )}

          {isActionable && (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={onBuy}
                disabled={busy}
                className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-emerald-300 transition hover:bg-emerald-500/20 disabled:opacity-40"
              >
                Bought
              </button>
              <button
                type="button"
                onClick={onPass}
                disabled={busy}
                className="rounded-md border border-white/[0.1] bg-white/[0.02] px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground transition hover:bg-white/[0.06] hover:text-foreground disabled:opacity-40"
              >
                {busy ? 'Passing…' : 'Passed'}
              </button>
              {insight.action?.ticker && (
                <span className="basis-full font-mono text-[10px] text-muted-foreground/70 sm:basis-auto">
                  {insight.action.type ?? 'buy'} {insight.action.shares ?? '?'} ×{' '}
                  {insight.action.ticker}
                  {insight.action.priceSnapshot !== null
                    ? ` @ ${fmtMoney(
                        insight.action.priceSnapshot,
                        insight.action.priceCurrency ?? 'USD',
                      )}`
                    : ''}
                </span>
              )}
            </div>
          )}

          {reviewPositionHref && (
            <div className="mt-4">
              <Link
                href={reviewPositionHref}
                className="inline-flex items-center gap-2 rounded-md border border-white/[0.1] bg-white/[0.02] px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground transition hover:bg-white/[0.06] hover:text-foreground"
              >
                <Target className="size-3.5" aria-hidden />
                Review position
              </Link>
            </div>
          )}

          {toast && (
            <div className="mt-3 rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 font-mono text-[10px] text-muted-foreground">
              {toast}
            </div>
          )}
        </div>
      </div>
    </FrostedPanel>
  );
}

function RotationCard({
  action,
  body,
}: {
  action: NonNullable<InsightView['action']>;
  body: string;
}): React.ReactElement {
  const trim = action.trimTicker ?? '?';
  const buy = action.buyTicker ?? action.ticker ?? '?';
  const trimShares = action.trimShares ?? null;
  const buyShares = action.buyShares ?? action.shares ?? null;
  const trimPrice = action.trimPriceSnapshot ?? null;
  const buyPrice = action.priceSnapshot ?? null;
  const delta = action.scoreDelta ?? null;

  return (
    <div className="mt-2 flex flex-col gap-3">
      <div className="grid grid-cols-1 items-stretch gap-2 sm:grid-cols-[1fr_auto_1fr]">
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/[0.06] p-3">
          <div className="font-mono text-[9px] uppercase tracking-[0.25em] text-rose-300/80">
            TRIM
          </div>
          <div className="mt-1 font-mono text-lg font-semibold tabular-nums text-rose-200">
            {trim}
          </div>
          <div className="font-mono text-[10px] tabular-nums text-rose-300/70">
            {trimShares !== null ? `${trimShares} sh` : '— sh'}
            {trimPrice !== null
              ? ` · ${fmtMoney(trimPrice, action.trimPriceCurrency ?? 'USD')}`
              : ''}
          </div>
        </div>
        <div className="flex items-center justify-center gap-2 px-1 sm:flex-col sm:gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
            Δ
          </span>
          <span className="font-mono text-base tabular-nums text-foreground">
            {delta !== null ? `+${delta.toFixed(2)}` : '—'}
          </span>
          <span aria-hidden className="font-mono text-muted-foreground/60">
            ↔
          </span>
        </div>
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/[0.06] p-3">
          <div className="font-mono text-[9px] uppercase tracking-[0.25em] text-emerald-300/80">
            BUY
          </div>
          <div className="mt-1 font-mono text-lg font-semibold tabular-nums text-emerald-200">
            {buy}
          </div>
          <div className="font-mono text-[10px] tabular-nums text-emerald-300/70">
            {buyShares !== null ? `${buyShares} sh` : '— sh'}
            {buyPrice !== null ? ` · ${fmtMoney(buyPrice, action.priceCurrency ?? 'USD')}` : ''}
          </div>
        </div>
      </div>
      <p className="whitespace-pre-wrap text-sm text-foreground/80">{body}</p>
    </div>
  );
}

const CONFIDENCE_TONE: Record<string, string> = {
  Low: 'border-zinc-500/40 text-zinc-300',
  Medium: 'border-amber-500/40 text-amber-300',
  High: 'border-emerald-500/40 text-emerald-300',
};

function iconFor(
  insight: Pick<InsightView, 'kind' | 'action'>,
): React.ComponentType<{ className?: string }> {
  if (insight.kind === 'Rebalance' && insight.action?.type === 'rotation') {
    return Shuffle;
  }
  switch (insight.kind) {
    case 'Alert':
      return AlertTriangle;
    case 'BuySuggestion':
      return Sparkles;
    case 'Rebalance':
      return ArrowRightLeft;
    case 'ThesisUpdate':
    default:
      return Target;
  }
}

function ConjunctionDots({ level }: { level: number }): React.ReactElement {
  const filled = Math.max(0, Math.min(3, Math.round(level)));
  return (
    <div
      title={`Conjunction level ${filled}/3`}
      aria-label={`Conjunction level ${filled} of 3`}
      className="flex items-center gap-0.5"
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={cn(
            'size-1.5 rounded-full',
            i < filled ? 'bg-[var(--cc-accent)] shadow-[0_0_4px_var(--cc-accent)]' : 'bg-white/20',
          )}
        />
      ))}
    </div>
  );
}

function UrgencyTag({ expiresAt }: { expiresAt: string }): React.ReactElement | null {
  const expMs = new Date(expiresAt).getTime();
  if (Number.isNaN(expMs)) return null;
  const remaining = expMs - Date.now();
  if (remaining <= 0) {
    return (
      <span className="rounded-full border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.2em] text-rose-300">
        <Clock3 className="mr-1 inline size-3" aria-hidden /> Expired
      </span>
    );
  }
  const hours = Math.max(1, Math.round(remaining / 3_600_000));
  return (
    <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.2em] text-amber-300">
      <Clock3 className="mr-1 inline size-3" aria-hidden /> {hours}h remaining
    </span>
  );
}
