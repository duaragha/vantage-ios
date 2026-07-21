/**
 * VerdictLegend — collapsible info card on the /compare page header.
 *
 * Lists every verdict kind with its tone chip and one-liner, grouped by held
 * vs unheld. Click-to-expand (not a modal) so users can glance at the table
 * with it open. The legend data is sourced from
 * packages/core/src/discover/verdict.ts so label + description stay in sync
 * with the verdict function.
 */

'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import type { VerdictTone, VerdictKind } from '@vantage/core/verdict';

// Mirror of packages/core/src/discover/verdict.ts VERDICT_LEGEND — inlined here
// so the client bundle doesn't transitively import the server-only core package
// (which pulls in Finnhub/yfinance adapters and node builtins).
interface VerdictLegendEntry {
  kind: VerdictKind;
  tone: VerdictTone;
  scope: 'held' | 'unheld';
  description: string;
}

const VERDICT_LEGEND: readonly VerdictLegendEntry[] = [
  {
    kind: 'EXIT',
    tone: 'rose',
    scope: 'held',
    description: 'Thesis is Broken — close the position.',
  },
  {
    kind: 'TRIM',
    tone: 'amber',
    scope: 'held',
    description: 'Thesis Weakening + price down >10% in 30d; reduce exposure.',
  },
  {
    kind: 'WATCH',
    tone: 'amber',
    scope: 'held',
    description:
      'Thesis Weakening, price holding up — or moderate-score candidate for the watchlist.',
  },
  {
    kind: 'ADD',
    tone: 'emerald',
    scope: 'held',
    description: 'Thesis Strengthening with room below the position cap — add to the position.',
  },
  {
    kind: 'HOLD+',
    tone: 'emerald',
    scope: 'held',
    description: 'Thesis Strengthening but you are already near the cap — hold.',
  },
  { kind: 'HOLD', tone: 'zinc', scope: 'held', description: 'Thesis Intact — no action needed.' },
  {
    kind: 'NEEDS THESIS',
    tone: 'zinc',
    scope: 'held',
    description: 'No thesis on file — write one or run Bootstrap.',
  },
  {
    kind: 'BUY',
    tone: 'emerald',
    scope: 'unheld',
    description: 'Score ≥ 6.0 with tier-1 news plus earnings beat or insider buying.',
  },
  {
    kind: 'WATCH',
    tone: 'amber',
    scope: 'unheld',
    description: 'Moderate score (≥ 3.0); add to the watchlist.',
  },
  {
    kind: 'MONITOR',
    tone: 'zinc',
    scope: 'unheld',
    description: 'Low positive score — monitor only.',
  },
  {
    kind: 'AVOID',
    tone: 'rose',
    scope: 'unheld',
    description: 'Negative composite score — active negative catalysts.',
  },
];

const TONE_CLASSES: Record<VerdictTone, string> = {
  emerald: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  amber: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  rose: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
  zinc: 'border-white/15 bg-white/[0.04] text-foreground/75',
};

export function VerdictLegend(): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const heldEntries = VERDICT_LEGEND.filter((e) => e.scope === 'held');
  const unheldEntries = VERDICT_LEGEND.filter((e) => e.scope === 'unheld');

  return (
    <div className="flex flex-col items-start gap-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground transition hover:border-[var(--cc-accent)]/40 hover:bg-white/[0.06] hover:text-foreground/90',
          open && 'border-[var(--cc-accent)]/40 text-[var(--cc-accent)]',
        )}
      >
        <InfoGlyph />
        <span>What do these mean?</span>
      </button>
      {open && (
        <div className="w-full max-w-2xl rounded-md border border-white/[0.08] bg-black/40 p-4 backdrop-blur-xl">
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <LegendGroup title="Held positions" entries={heldEntries} />
            <LegendGroup title="Market candidates" entries={unheldEntries} />
          </div>
        </div>
      )}
    </div>
  );
}

function LegendGroup({
  title,
  entries,
}: {
  title: string;
  entries: readonly VerdictLegendEntry[];
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-2">
      <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
        {title}
      </div>
      <ul className="flex flex-col gap-1.5">
        {entries.map((entry) => (
          <li key={entry.kind} className="flex items-start gap-2.5">
            <span
              className={cn(
                'mt-0.5 inline-flex shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.2em]',
                TONE_CLASSES[entry.tone],
              )}
            >
              {entry.kind}
            </span>
            <span className="text-xs leading-relaxed text-foreground/80">{entry.description}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function InfoGlyph(): React.ReactElement {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className="size-3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="8" cy="8" r="6.5" />
      <path d="M8 7.5v4" />
      <circle cx="8" cy="5" r="0.5" fill="currentColor" />
    </svg>
  );
}
