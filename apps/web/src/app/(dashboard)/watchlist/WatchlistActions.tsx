/**
 * Watchlist action cluster — add / remove / promote.
 */

'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { Drawer } from '@/components/Drawer';
import { addWatchlist, removeWatchlist } from './actions';

export function WatchlistActions(): React.ReactElement {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [ticker, setTicker] = React.useState('');
  const [reason, setReason] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await addWatchlist(ticker, reason);
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? 'failed');
      return;
    }
    setTicker('');
    setReason('');
    setOpen(false);
    router.refresh();
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-md border border-[var(--cc-accent)]/30 bg-gradient-to-b from-[var(--cc-accent)]/20 to-transparent px-3 py-2 font-mono text-xs uppercase tracking-[0.2em] text-[var(--cc-accent)] transition hover:from-[var(--cc-accent)]/30"
      >
        <Plus className="size-3.5" />
        Add to watchlist
      </button>
      <Drawer
        open={open}
        title="Add ticker"
        description="Polling picks it up on the next cron tick."
        onClose={() => setOpen(false)}
      >
        <form onSubmit={submit} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              Ticker
            </span>
            <input
              value={ticker}
              onChange={(e) => setTicker(e.target.value.toUpperCase())}
              className="h-9 rounded-md border border-white/[0.08] bg-black/30 px-3 font-mono text-sm uppercase outline-none focus:border-[var(--cc-accent)]/60"
              required
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              Why
            </span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              className="rounded-md border border-white/[0.08] bg-black/30 px-3 py-2 text-sm outline-none focus:border-[var(--cc-accent)]/60"
              placeholder="Short note. Keep it honest."
            />
          </label>
          {error && (
            <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 font-mono text-xs text-rose-300">
              {error}
            </div>
          )}
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={busy}
              className="rounded-md border border-[var(--cc-accent)]/30 bg-gradient-to-b from-[var(--cc-accent)]/20 to-transparent px-4 py-2 font-mono text-xs uppercase tracking-[0.2em] text-[var(--cc-accent)] transition hover:from-[var(--cc-accent)]/30 disabled:opacity-40"
            >
              {busy ? 'Adding…' : 'Add'}
            </button>
          </div>
        </form>
      </Drawer>
    </>
  );
}

export function WatchlistRowActions({
  ticker,
}: {
  ticker: string;
}): React.ReactElement {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);

  const remove = async () => {
    if (!window.confirm(`Remove ${ticker} from watchlist?`)) return;
    setBusy(true);
    await removeWatchlist(ticker);
    setBusy(false);
    router.refresh();
  };

  return (
    <div className="flex items-center justify-end gap-2">
      <Link
        href={`/portfolio/add?ticker=${ticker}`}
        className="rounded-md border border-white/[0.08] px-2 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground transition hover:border-[var(--cc-accent)]/40 hover:text-[var(--cc-accent)]"
      >
        Promote
      </Link>
      <button
        type="button"
        onClick={remove}
        disabled={busy}
        className="rounded-md border border-white/[0.08] px-2 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground transition hover:border-rose-500/40 hover:text-rose-300 disabled:opacity-40"
      >
        Remove
      </button>
    </div>
  );
}
