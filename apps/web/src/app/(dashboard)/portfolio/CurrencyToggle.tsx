/**
 * CurrencyToggle — segmented CAD/USD control that pushes `?ccy=CAD|USD` so the
 * server-side data fetch re-values every dollar on the page in the chosen
 * display currency. Mirrors the URL-param pattern AccountFilter uses; the
 * `accountFilter` prop is accepted only so the toggle preserves any active
 * account filter when it rewrites the query string.
 */

'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { cn } from '@/lib/utils';

export function CurrencyToggle({
  displayCurrency,
}: {
  displayCurrency: 'CAD' | 'USD';
  /** Present for call-site symmetry; the active filter is read from the URL. */
  accountFilter?: number | 'archived' | null;
}): React.ReactElement {
  const router = useRouter();
  const sp = useSearchParams();

  const select = (ccy: 'CAD' | 'USD') => {
    const params = new URLSearchParams(sp.toString());
    // CAD is the default — drop the param to keep URLs clean.
    if (ccy === 'CAD') params.delete('ccy');
    else params.set('ccy', 'USD');
    const qs = params.toString();
    router.push(qs ? `/portfolio?${qs}` : '/portfolio');
  };

  return (
    <div className="flex items-center gap-1 rounded-md border border-white/[0.08] bg-black/30 p-0.5">
      {(['CAD', 'USD'] as const).map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => select(c)}
          aria-pressed={displayCurrency === c}
          className={cn(
            'rounded px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.2em] transition',
            displayCurrency === c
              ? 'bg-[var(--cc-accent)]/15 text-[var(--cc-accent)]'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {c}
        </button>
      ))}
    </div>
  );
}
