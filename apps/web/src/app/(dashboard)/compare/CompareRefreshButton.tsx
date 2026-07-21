/**
 * CompareRefreshButton — kicks the worker compute for held + top 50 unheld,
 * then forces a server re-render. Errors surface as a tiny red toast.
 */

'use client';

import * as React from 'react';
import { RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';
import { refreshCompareAction } from './actions';

export function CompareRefreshButton(): React.ReactElement {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [toast, setToast] = React.useState<string | null>(null);

  const onRefresh = async () => {
    setBusy(true);
    setToast(null);
    const res = await refreshCompareAction();
    setBusy(false);
    if (res.ok) {
      setToast(
        res.holdingsScored !== undefined
          ? `Scored ${res.holdingsScored} holding${res.holdingsScored === 1 ? '' : 's'}`
          : 'Refresh triggered',
      );
      router.refresh();
    } else {
      setToast(res.error ?? 'failed');
    }
  };

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onRefresh}
        disabled={busy}
        className={cn(
          'inline-flex items-center gap-2 rounded-md border border-white/[0.1] bg-white/[0.04] px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-foreground/80 transition hover:bg-white/[0.08] disabled:opacity-40',
        )}
      >
        <RefreshCw className={cn('size-3.5', busy && 'animate-spin')} />
        {busy ? 'Refreshing' : 'Refresh'}
      </button>
      {toast && (
        <div className="font-mono text-[10px] text-muted-foreground">
          {toast}
        </div>
      )}
    </div>
  );
}
