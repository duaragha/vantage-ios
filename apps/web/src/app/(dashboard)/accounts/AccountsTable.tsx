/**
 * AccountsTable — client wrapper around the list table.
 *
 * Holds drawer state for New / Edit forms. Receives the resolved
 * `AccountListItem[]` from the server component so the initial render is
 * still data-correct without a client fetch.
 */

'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { Drawer } from '@/components/Drawer';
import { AccountBadge } from '@/components/AccountBadge';
import { cn } from '@/lib/utils';
import { deleteAccount, unarchiveAccount } from './actions';
import type { AccountListItem } from './data';
import { NewAccountForm } from './NewAccountForm';
import { EditAccountForm } from './EditAccountForm';

function fmtCadInt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `C$${n.toLocaleString('en-CA', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

function fmtCad(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `C$${n.toLocaleString('en-CA', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

export function AccountsTable({
  accounts,
  showArchived,
}: {
  accounts: AccountListItem[];
  showArchived: boolean;
}): React.ReactElement {
  const router = useRouter();
  const [newOpen, setNewOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<AccountListItem | null>(null);
  const [busyId, setBusyId] = React.useState<number | null>(null);
  const [toast, setToast] = React.useState<string | null>(null);

  const toggleArchived = () => {
    const params = new URLSearchParams(window.location.search);
    if (showArchived) {
      params.delete('archived');
    } else {
      params.set('archived', '1');
    }
    const qs = params.toString();
    router.push(qs ? `/accounts?${qs}` : '/accounts');
  };

  const onDelete = async (a: AccountListItem) => {
    if (a.positionCount > 0) {
      setToast(
        `"${a.name}" still holds ${a.positionCount} open position${a.positionCount === 1 ? '' : 's'}. Archive instead.`,
      );
      return;
    }
    if (!window.confirm(`Permanently delete "${a.name}"? This cannot be undone.`)) {
      return;
    }
    setBusyId(a.id);
    setToast(null);
    const res = await deleteAccount(a.id);
    setBusyId(null);
    if (!res.ok) {
      setToast(res.error ?? 'delete failed');
      return;
    }
    router.refresh();
  };

  const onUnarchive = async (a: AccountListItem) => {
    setBusyId(a.id);
    setToast(null);
    const res = await unarchiveAccount(a.id);
    setBusyId(null);
    if (!res.ok) {
      setToast(res.error ?? 'restore failed');
      return;
    }
    router.refresh();
  };

  return (
    <>
      <div className="mb-4 flex min-w-0 flex-wrap items-center justify-between gap-3">
        <label className="flex min-h-11 cursor-pointer items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={toggleArchived}
            className="size-4 accent-[var(--cc-accent)]"
          />
          Show archived
        </label>
        <button
          type="button"
          onClick={() => setNewOpen(true)}
          className="inline-flex min-h-11 items-center gap-2 rounded-md border border-[var(--cc-accent)]/30 bg-gradient-to-b from-[var(--cc-accent)]/20 to-transparent px-3 py-2 font-mono text-xs uppercase tracking-[0.16em] text-[var(--cc-accent)] transition hover:from-[var(--cc-accent)]/30 sm:tracking-[0.2em]"
        >
          <Plus className="size-3.5" />
          New account
        </button>
      </div>

      {toast && (
        <div className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 font-mono text-xs text-amber-200">
          {toast}
        </div>
      )}

      {accounts.length === 0 ? (
        <div className="rounded-xl border border-white/[0.08] bg-white/[0.04] px-6 py-12 text-center">
          <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
            No accounts {showArchived ? '' : 'yet'}
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            {showArchived
              ? 'Nothing archived.'
              : 'Create one to start tagging positions per sub-account.'}
          </p>
        </div>
      ) : (
        <>
          <div className="grid min-w-0 gap-3 md:hidden">
            {accounts.map((a) => {
              const archived = a.archivedAt !== null;
              return (
                <article
                  key={a.id}
                  className={cn(
                    'cc-mobile-card min-w-0 overflow-hidden p-4',
                    archived && 'opacity-65',
                  )}
                >
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <button
                      type="button"
                      onClick={() => setEditing(a)}
                      className="flex min-h-11 min-w-0 flex-1 flex-col items-start justify-center gap-0.5 rounded-md text-left outline-none transition hover:text-[var(--cc-accent)] focus-visible:ring-2 focus-visible:ring-[var(--cc-accent)]/60"
                    >
                      <span className="max-w-full truncate text-base font-medium">{a.name}</span>
                      <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
                        {a.currency} account
                      </span>
                    </button>
                    <div className="flex shrink-0 flex-col items-end gap-1.5 pt-1">
                      <AccountBadge name={a.type} type={a.type} />
                      {archived && (
                        <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-amber-300/80">
                          archived
                        </span>
                      )}
                    </div>
                  </div>

                  <dl className="mt-4 grid min-w-0 grid-cols-2 gap-x-4 gap-y-3 border-t border-white/[0.06] pt-4">
                    <MobileAccountMetric label="Broker">{a.broker}</MobileAccountMetric>
                    <MobileAccountMetric label="Currency">{a.currency}</MobileAccountMetric>
                    <MobileAccountMetric label="Contribution room">
                      {fmtCadInt(a.contributionRoomCad)}
                    </MobileAccountMetric>
                    <MobileAccountMetric label="Open positions">
                      {a.positionCount}
                    </MobileAccountMetric>
                    <MobileAccountMetric label="Value (CAD)" className="col-span-2">
                      <span className="text-base text-foreground">{fmtCad(a.totalValueCad)}</span>
                    </MobileAccountMetric>
                  </dl>

                  <div className="mt-4 grid min-w-0 grid-cols-3 gap-2 border-t border-white/[0.06] pt-4">
                    <button
                      type="button"
                      onClick={() => setEditing(a)}
                      disabled={busyId === a.id}
                      className="min-h-11 min-w-0 rounded-md border border-white/[0.08] px-2 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground transition hover:border-white/[0.2] hover:text-foreground disabled:opacity-40"
                    >
                      Edit
                    </button>
                    {archived ? (
                      <button
                        type="button"
                        onClick={() => onUnarchive(a)}
                        disabled={busyId === a.id}
                        className="min-h-11 min-w-0 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-emerald-300 transition hover:bg-emerald-500/20 disabled:opacity-40"
                      >
                        Restore
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setEditing(a)}
                        disabled={busyId === a.id}
                        className="min-h-11 min-w-0 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-amber-300 transition hover:bg-amber-500/20 disabled:opacity-40"
                      >
                        Archive
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onDelete(a)}
                      disabled={busyId === a.id || a.positionCount > 0}
                      title={
                        a.positionCount > 0
                          ? 'Archive instead, positions still attached'
                          : 'Permanently delete'
                      }
                      className="min-h-11 min-w-0 rounded-md border border-rose-500/40 bg-rose-500/10 px-2 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-rose-300 transition hover:bg-rose-500/20 disabled:opacity-30"
                    >
                      Delete
                    </button>
                  </div>
                </article>
              );
            })}
          </div>

          <div className="hidden overflow-x-auto rounded-xl border border-white/[0.08] bg-white/[0.04] backdrop-blur-xl md:block">
            <table className="w-full min-w-[920px] text-sm">
              <thead>
                <tr className="border-b border-white/[0.06] text-left font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                  <Th>Name</Th>
                  <Th>Type</Th>
                  <Th>Currency</Th>
                  <Th>Broker</Th>
                  <Th className="text-right">Contrib. room</Th>
                  <Th className="text-right">Positions</Th>
                  <Th className="text-right">Value (CAD)</Th>
                  <Th className="text-right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => {
                  const archived = a.archivedAt !== null;
                  return (
                    <tr
                      key={a.id}
                      className={cn(
                        'border-b border-white/[0.04] transition hover:bg-white/[0.02]',
                        archived && 'opacity-60',
                      )}
                    >
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => setEditing(a)}
                          className="flex flex-col items-start gap-0.5 text-left transition hover:text-[var(--cc-accent)]"
                        >
                          <span className="text-sm font-medium">{a.name}</span>
                          {archived && (
                            <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-amber-300/80">
                              archived
                            </span>
                          )}
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <AccountBadge name={a.type} type={a.type} />
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                        {a.currency}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">{a.broker}</td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums text-muted-foreground">
                        {fmtCadInt(a.contributionRoomCad)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums">
                        {a.positionCount}
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums">
                        {fmtCad(a.totalValueCad)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => setEditing(a)}
                            disabled={busyId === a.id}
                            className="rounded-md border border-white/[0.08] px-2 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground transition hover:border-white/[0.2] hover:text-foreground disabled:opacity-40"
                          >
                            Edit
                          </button>
                          {archived ? (
                            <button
                              type="button"
                              onClick={() => onUnarchive(a)}
                              disabled={busyId === a.id}
                              className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-emerald-300 transition hover:bg-emerald-500/20 disabled:opacity-40"
                            >
                              Restore
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setEditing(a)}
                              disabled={busyId === a.id}
                              className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-amber-300 transition hover:bg-amber-500/20 disabled:opacity-40"
                            >
                              Archive
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => onDelete(a)}
                            disabled={busyId === a.id || a.positionCount > 0}
                            title={
                              a.positionCount > 0
                                ? 'Archive instead, positions still attached'
                                : 'Permanently delete'
                            }
                            className="rounded-md border border-rose-500/40 bg-rose-500/10 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-rose-300 transition hover:bg-rose-500/20 disabled:opacity-30"
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      <Drawer
        open={newOpen}
        onClose={() => setNewOpen(false)}
        title="New account"
        description="Create a Wealthsimple sub-account. Per-currency: a USD TFSA is a separate row from a CAD TFSA."
      >
        <NewAccountForm onDone={() => setNewOpen(false)} />
      </Drawer>

      <Drawer
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing ? `Edit ${editing.name}` : 'Edit account'}
        description="Update name / type / currency / room. Use Archive to hide without losing data."
      >
        {editing && <EditAccountForm account={editing} onDone={() => setEditing(null)} />}
      </Drawer>
    </>
  );
}

function MobileAccountMetric({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div className={cn('min-w-0', className)}>
      <dt className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 min-w-0 break-words font-mono text-sm tabular-nums text-foreground/80">
        {children}
      </dd>
    </div>
  );
}

function Th({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <th className={cn('px-4 py-3 font-medium text-muted-foreground', className)}>{children}</th>
  );
}
