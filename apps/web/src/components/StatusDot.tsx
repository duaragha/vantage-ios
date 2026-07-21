/**
 * StatusDot — pulsing live-data indicator.
 *
 * `fresh` pulses cyan; `stale` sits flat in zinc; `error` glows rose.
 */

import * as React from 'react';
import { cn } from '@/lib/utils';

export type LiveStatus = 'fresh' | 'stale' | 'error' | 'offline';

const COLORS: Record<LiveStatus, string> = {
  fresh: 'bg-[var(--cc-accent)]',
  stale: 'bg-zinc-500',
  error: 'bg-rose-500',
  offline: 'bg-zinc-700',
};

export function StatusDot({
  status,
  className,
}: {
  status: LiveStatus;
  className?: string;
}): React.ReactElement {
  return (
    <span className={cn('relative inline-flex size-2', className)}>
      {status === 'fresh' && (
        <span
          className={cn(
            'absolute inline-flex size-2 rounded-full opacity-60 cc-pulse',
            COLORS[status],
          )}
        />
      )}
      <span className={cn('relative inline-flex size-2 rounded-full', COLORS[status])} />
    </span>
  );
}
