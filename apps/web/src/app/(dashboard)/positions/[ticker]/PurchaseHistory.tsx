'use client';

import * as React from 'react';
import { CalendarDays, Pencil, Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Drawer } from '@/components/Drawer';
import { cn } from '@/lib/utils';
import { torontoDateKey } from '@/lib/positionLotInput';
import { createPurchaseLot, deletePurchaseLot, updatePurchaseLot } from './purchaseActions';

export interface PurchaseLotView {
  id: number;
  acquiredAt: string | null;
  shares: string;
  costPerShare: string;
  source: 'Manual' | 'Import' | 'Legacy';
  disposedAt: string | null;
  note: string | null;
}

export function PurchaseHistory({
  positionId,
  ticker,
  currency,
  closed,
  lots,
}: {
  positionId: number;
  ticker: string;
  currency: 'CAD' | 'USD';
  closed: boolean;
  lots: PurchaseLotView[];
}): React.ReactElement {
  const router = useRouter();
  const [editing, setEditing] = React.useState<PurchaseLotView | 'new' | null>(null);
  const [deletingId, setDeletingId] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const activeLots = lots.filter((lot) => !lot.disposedAt);

  const remove = async (lot: PurchaseLotView) => {
    if (!window.confirm(`Remove this ${ticker} purchase from history?`)) return;
    setDeletingId(lot.id);
    setError(null);
    try {
      const result = await deletePurchaseLot(lot.id, positionId, ticker);
      if (!result.ok) {
        setError(result.error ?? 'Purchase could not be removed.');
        return;
      }
      router.refresh();
    } catch {
      setError('Purchase could not be removed.');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <section className="mb-6 overflow-hidden rounded-md border border-white/[0.07] bg-white/[0.018]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.06] px-5 py-4">
        <div>
          <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            <CalendarDays className="size-3.5" aria-hidden />
            Purchase history
          </div>
          <p className="mt-1 text-xs text-muted-foreground/75">
            {activeLots.length} active {activeLots.length === 1 ? 'lot' : 'lots'} · shares and
            average cost are calculated from this ledger
          </p>
        </div>
        {!closed && (
          <button
            type="button"
            onClick={() => setEditing('new')}
            title="Add purchase"
            className="inline-flex size-9 items-center justify-center rounded-md border border-[var(--cc-accent)]/30 bg-[var(--cc-accent)]/10 text-[var(--cc-accent)] transition hover:bg-[var(--cc-accent)]/20"
          >
            <Plus className="size-4" aria-hidden />
            <span className="sr-only">Add purchase</span>
          </button>
        )}
      </div>

      <div className="divide-y divide-white/[0.05]">
        {lots.map((lot) => {
          const shares = Number(lot.shares);
          const cost = Number(lot.costPerShare);
          const active = !lot.disposedAt;
          return (
            <article
              key={lot.id}
              className={cn(
                'grid grid-cols-2 gap-x-4 gap-y-3 px-5 py-4 sm:grid-cols-[minmax(9rem,1.2fr)_repeat(3,minmax(7rem,1fr))_auto] sm:items-center',
                !active && 'opacity-60',
              )}
            >
              <div className="col-span-2 min-w-0 sm:col-span-1">
                <div className="font-mono text-sm text-foreground">
                  {lot.acquiredAt ? formatPurchaseDate(lot.acquiredAt) : 'Date unknown'}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                  <span className="font-mono uppercase tracking-[0.16em]">
                    {sourceLabel(lot.source)}
                  </span>
                  {!active && (
                    <span className="rounded border border-white/[0.1] px-1.5 py-0.5 font-mono uppercase tracking-[0.14em]">
                      closed {formatClosedDate(lot.disposedAt!)}
                    </span>
                  )}
                </div>
                {lot.note && (
                  <p className="mt-1 truncate text-xs text-muted-foreground">{lot.note}</p>
                )}
              </div>
              <LotMetric label="Shares" value={formatShares(shares)} />
              <LotMetric label="Cost / share" value={formatMoney(cost, currency)} />
              <LotMetric label="Cost basis" value={formatMoney(shares * cost, currency)} />
              <div className="col-span-2 flex items-center justify-end gap-1 sm:col-span-1">
                <button
                  type="button"
                  onClick={() => setEditing(lot)}
                  title="Edit purchase"
                  className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-white/[0.06] hover:text-foreground"
                >
                  <Pencil className="size-3.5" aria-hidden />
                  <span className="sr-only">Edit purchase</span>
                </button>
                <button
                  type="button"
                  onClick={() => void remove(lot)}
                  disabled={deletingId !== null || (active && activeLots.length <= 1)}
                  title={
                    active && activeLots.length <= 1
                      ? 'A holding needs one active purchase'
                      : 'Remove purchase'
                  }
                  className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-rose-500/10 hover:text-rose-300 disabled:cursor-not-allowed disabled:opacity-25"
                >
                  <Trash2 className="size-3.5" aria-hidden />
                  <span className="sr-only">Remove purchase</span>
                </button>
              </div>
            </article>
          );
        })}
      </div>

      {error && (
        <div className="border-t border-rose-500/20 bg-rose-500/[0.08] px-5 py-3 text-xs text-rose-200">
          {error}
        </div>
      )}

      <Drawer
        open={editing !== null}
        title={editing === 'new' ? `Add ${ticker} purchase` : `Edit ${ticker} purchase`}
        description="Each row is one acquisition. Updating it recalculates the holding total and weighted average cost."
        onClose={() => setEditing(null)}
      >
        {editing && (
          <PurchaseForm
            key={editing === 'new' ? 'new' : editing.id}
            positionId={positionId}
            ticker={ticker}
            currency={currency}
            lot={editing === 'new' ? null : editing}
            onDone={() => {
              setEditing(null);
              setError(null);
              router.refresh();
            }}
          />
        )}
      </Drawer>
    </section>
  );
}

function PurchaseForm({
  positionId,
  ticker,
  currency,
  lot,
  onDone,
}: {
  positionId: number;
  ticker: string;
  currency: 'CAD' | 'USD';
  lot: PurchaseLotView | null;
  onDone: () => void;
}): React.ReactElement {
  const [shares, setShares] = React.useState(lot?.shares ?? '');
  const [cost, setCost] = React.useState(lot?.costPerShare ?? '');
  const [date, setDate] = React.useState(lot ? (lot.acquiredAt ?? '') : torontoDateKey());
  const [note, setNote] = React.useState(lot?.note ?? '');
  const [working, setWorking] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setWorking(true);
    setError(null);
    try {
      const input = {
        shares: Number(shares),
        costPerShare: Number(cost),
        acquiredAt: date || null,
        note: note || null,
      };
      const result = lot
        ? await updatePurchaseLot(lot.id, positionId, ticker, input)
        : await createPurchaseLot(positionId, ticker, input);
      if (!result.ok) {
        setError(result.error ?? 'Purchase could not be saved.');
        return;
      }
      onDone();
    } catch {
      setError('Purchase could not be saved.');
    } finally {
      setWorking(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField label="Shares purchased">
          <input
            value={shares}
            onChange={(event) => setShares(event.target.value)}
            type="number"
            min="0.0001"
            step="0.0001"
            inputMode="decimal"
            className="cc-input font-mono tabular-nums"
            required
          />
        </FormField>
        <FormField label={`Cost per share (${currency})`}>
          <input
            value={cost}
            onChange={(event) => setCost(event.target.value)}
            type="number"
            min="0"
            step="0.0001"
            inputMode="decimal"
            className="cc-input font-mono tabular-nums"
            required
          />
        </FormField>
        <FormField label="Purchase date">
          <input
            value={date}
            onChange={(event) => setDate(event.target.value)}
            type="date"
            max={torontoDateKey()}
            className="cc-input font-mono tabular-nums"
            required={!lot || lot.source === 'Manual'}
          />
        </FormField>
        <FormField label="Note (optional)">
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={240}
            placeholder="DRIP, second buy, transfer..."
            className="cc-input"
          />
        </FormField>
      </div>
      {lot?.source === 'Legacy' && !lot.acquiredAt && (
        <p className="text-xs text-amber-200/80">
          This opening balance was migrated from the old snapshot. Add the real purchase date here,
          or split it into multiple purchases by correcting this row and adding the others.
        </p>
      )}
      {error && (
        <div className="rounded-md border border-rose-500/30 bg-rose-500/[0.08] px-3 py-2 text-xs text-rose-200">
          {error}
        </div>
      )}
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={working}
          className="rounded-md border border-[var(--cc-accent)]/30 bg-[var(--cc-accent)]/10 px-4 py-2 text-sm text-[var(--cc-accent)] transition hover:bg-[var(--cc-accent)]/20 disabled:opacity-40"
        >
          {working ? 'Saving...' : lot ? 'Save purchase' : 'Add purchase'}
        </button>
      </div>
    </form>
  );
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}

function LotMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-mono text-[9px] uppercase tracking-[0.16em] text-muted-foreground/65">
        {label}
      </div>
      <div className="mt-1 font-mono text-sm tabular-nums text-foreground/90">{value}</div>
    </div>
  );
}

function sourceLabel(source: PurchaseLotView['source']): string {
  if (source === 'Legacy') return 'Opening balance';
  if (source === 'Import') return 'Imported balance';
  return 'Purchase';
}

function formatPurchaseDate(value: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    dateStyle: 'medium',
    timeZone: 'UTC',
  }).format(new Date(value));
}

function formatClosedDate(value: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    dateStyle: 'medium',
    timeZone: 'America/Toronto',
  }).format(new Date(value));
}

function formatMoney(value: number, currency: 'CAD' | 'USD'): string {
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatShares(value: number): string {
  return new Intl.NumberFormat('en-CA', { maximumFractionDigits: 4 }).format(value);
}
