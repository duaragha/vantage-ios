/**
 * ThesisGlow — the 3px left-edge glow strip used on position rows and thesis
 * cards. Color maps to ThesisStatus (+ 'Stale' for rows whose thesis hasn't
 * been validated in 30+ days).
 */

import * as React from 'react';
import { cn } from '@/lib/utils';

export type ThesisHealth =
  | 'Intact'
  | 'Strengthening'
  | 'Weakening'
  | 'Broken'
  | 'Stale'
  | 'None';

const COLOR: Record<ThesisHealth, string> = {
  Intact: 'bg-[var(--cc-intact)] shadow-[0_0_10px_var(--cc-intact)]',
  Strengthening: 'bg-[var(--cc-strengthening)] shadow-[0_0_10px_var(--cc-strengthening)]',
  Weakening: 'bg-[var(--cc-weakening)] shadow-[0_0_10px_var(--cc-weakening)]',
  Broken: 'bg-[var(--cc-broken)] shadow-[0_0_12px_var(--cc-broken)]',
  Stale: 'bg-[var(--cc-stale)]',
  None: 'bg-white/10',
};

const LABEL_COLOR: Record<ThesisHealth, string> = {
  Intact: 'text-emerald-300',
  Strengthening: 'text-emerald-200',
  Weakening: 'text-amber-300',
  Broken: 'text-rose-300',
  Stale: 'text-zinc-400',
  None: 'text-muted-foreground',
};

export function ThesisStrip({
  status,
  className,
}: {
  status: ThesisHealth;
  className?: string;
}): React.ReactElement {
  return <span className={cn('cc-strip', COLOR[status], className)} aria-hidden="true" />;
}

export function ThesisLabel({
  status,
  className,
}: {
  status: ThesisHealth;
  className?: string;
}): React.ReactElement {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.2em]',
        LABEL_COLOR[status],
        className,
      )}
    >
      <span className={cn('size-1.5 rounded-full', COLOR[status])} />
      {status}
    </span>
  );
}
