/**
 * AccountBadge — small colored pill identifying which Account a Position
 * belongs to. Color is keyed off the account TYPE (registered = greenish,
 * margin = amber, etc) rather than the account id, so the same TFSA badge
 * looks the same across portfolio, positions detail, and accounts pages.
 */

import * as React from 'react';
import { cn } from '@/lib/utils';

export type AccountTypeKey =
  | 'TFSA'
  | 'RRSP'
  | 'SpousalRRSP'
  | 'RESP'
  | 'LIRA'
  | 'RRIF'
  | 'Personal'
  | 'Margin'
  | 'Corporate';

interface AccountBadgeProps {
  name: string;
  type: AccountTypeKey | string;
  /** Optional — when set, the type abbreviation is shown alongside the name. */
  showType?: boolean;
  className?: string;
}

/**
 * Color tokens are tied to the type's tax / risk character — emerald for
 * tax-sheltered (TFSA), blue for tax-deferred (RRSP family), zinc for
 * personal-non-reg, amber for margin (leverage = warning), etc.
 */
function classesFor(type: string): string {
  switch (type) {
    case 'TFSA':
      return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300';
    case 'RRSP':
    case 'SpousalRRSP':
    case 'LIRA':
    case 'RRIF':
      return 'border-blue-500/40 bg-blue-500/10 text-blue-300';
    case 'RESP':
      return 'border-violet-500/40 bg-violet-500/10 text-violet-300';
    case 'Margin':
      return 'border-amber-500/40 bg-amber-500/10 text-amber-300';
    case 'Corporate':
      return 'border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-300';
    case 'Personal':
    default:
      return 'border-zinc-500/40 bg-zinc-500/10 text-zinc-300';
  }
}

function shortLabelFor(type: string): string {
  if (type === 'SpousalRRSP') return 'SP-RRSP';
  return type;
}

export function AccountBadge({
  name,
  type,
  showType = false,
  className,
}: AccountBadgeProps): React.ReactElement {
  return (
    <span
      title={`${name} · ${type}`}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.15em]',
        classesFor(type),
        className,
      )}
    >
      <span className="max-w-[14ch] truncate">{name}</span>
      {showType && (
        <span className="opacity-70">· {shortLabelFor(type)}</span>
      )}
    </span>
  );
}

export { classesFor as accountBadgeClasses };
