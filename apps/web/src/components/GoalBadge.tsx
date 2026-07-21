import * as React from 'react';

type GoalType =
  | 'Withdrawal'
  | 'DownPayment'
  | 'Vacation'
  | 'TaxBill'
  | 'EmergencyFund'
  | 'Income'
  | 'Retirement'
  | 'Education'
  | 'Custom'
  | 'DayTrading';

// Palette: short-term liquidation = amber, urgent = rose, income = emerald,
// long-horizon = blue, education = violet, custom = zinc, day-trading = rose
// (deliberately the high-alert tone — it's a speculation surface, not investing).
const TONE: Record<GoalType, { bg: string; text: string; border: string }> = {
  Withdrawal: { bg: 'bg-amber-500/10', text: 'text-amber-300', border: 'border-amber-500/30' },
  DownPayment: { bg: 'bg-amber-500/10', text: 'text-amber-300', border: 'border-amber-500/30' },
  Vacation: { bg: 'bg-amber-500/10', text: 'text-amber-300', border: 'border-amber-500/30' },
  TaxBill: { bg: 'bg-amber-500/10', text: 'text-amber-300', border: 'border-amber-500/30' },
  EmergencyFund: { bg: 'bg-rose-500/10', text: 'text-rose-300', border: 'border-rose-500/30' },
  Income: { bg: 'bg-emerald-500/10', text: 'text-emerald-300', border: 'border-emerald-500/30' },
  Retirement: { bg: 'bg-blue-500/10', text: 'text-blue-300', border: 'border-blue-500/30' },
  Education: { bg: 'bg-violet-500/10', text: 'text-violet-300', border: 'border-violet-500/30' },
  Custom: { bg: 'bg-zinc-500/10', text: 'text-zinc-300', border: 'border-zinc-500/30' },
  DayTrading: { bg: 'bg-rose-500/15', text: 'text-rose-300', border: 'border-rose-500/40' },
};

const FRIENDLY: Record<GoalType, string> = {
  Withdrawal: 'Withdrawal',
  DownPayment: 'Down Payment',
  Vacation: 'Vacation',
  TaxBill: 'Tax Bill',
  EmergencyFund: 'Emergency',
  Income: 'Income',
  Retirement: 'Retirement',
  Education: 'Education',
  Custom: 'Custom',
  DayTrading: 'Day Trading',
};

export function GoalBadge({
  type,
  compact = false,
}: {
  type: GoalType;
  compact?: boolean;
}): React.ReactElement {
  const t = TONE[type];
  return (
    <span
      className={
        'inline-flex items-center rounded-full border font-mono ' +
        (compact ? 'px-1.5 py-0 text-[10px]' : 'px-2 py-0.5 text-xs') +
        ' ' +
        t.bg +
        ' ' +
        t.text +
        ' ' +
        t.border
      }
    >
      {FRIENDLY[type]}
    </span>
  );
}
