'use client';

import * as React from 'react';

export interface GoalProgressBarProps {
  currentCad: number;
  targetCad: number;
  percentComplete: number;
  onTrack: boolean;
  targetDate?: Date | null;
  compact?: boolean;
}

const cadFmt = (v: number) =>
  v.toLocaleString('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 });

export function GoalProgressBar({
  currentCad,
  targetCad,
  percentComplete,
  onTrack,
  targetDate,
  compact = false,
}: GoalProgressBarProps): React.ReactElement {
  const pct = Math.max(0, Math.min(100, percentComplete));
  const shortfall = targetCad - currentCad;
  const isOpenEnded = targetDate === null;
  const tone = isOpenEnded
    ? 'bg-sky-500'
    : onTrack
      ? 'bg-emerald-500'
      : shortfall <= targetCad * 0.2
        ? 'bg-amber-500'
        : 'bg-rose-500';
  const status = isOpenEnded ? 'open-ended' : onTrack ? 'on track' : 'behind';

  if (compact) {
    return (
      <div className="flex items-center gap-2">
        <div className="h-1.5 w-24 overflow-hidden rounded-full bg-white/[0.06]">
          <div className={'h-full ' + tone} style={{ width: pct + '%' }} />
        </div>
        <span className="font-mono text-xs text-zinc-400">
          {pct.toFixed(0)}% · {status}
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="h-3 overflow-hidden rounded-full bg-white/[0.06]">
        <div className={'h-full ' + tone} style={{ width: pct + '%' }} />
      </div>
      <div className="flex items-center justify-between font-mono text-xs text-zinc-400">
        <span>
          {cadFmt(currentCad)} / {cadFmt(targetCad)}
        </span>
        <span>
          {pct.toFixed(1)}% · {status}
        </span>
      </div>
    </div>
  );
}
