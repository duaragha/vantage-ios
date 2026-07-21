'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { GoalBadge } from '@/components/GoalBadge';
import { GoalProgressBar } from './GoalProgressBar';
import { NewGoalForm } from './NewGoalForm';
import { archiveGoal, unarchiveGoal, deleteGoal } from './actions';
import type { GoalListItem } from './data';

const cadFmt = (v: number) =>
  v.toLocaleString('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 });
const dateFmt = (d: Date) =>
  d.toLocaleDateString('en-CA', {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

export function GoalsTable({
  goals,
  accounts,
  showArchived,
}: {
  goals: GoalListItem[];
  accounts: Array<{ id: number; name: string; type: string }>;
  showArchived: boolean;
}): React.ReactElement {
  const router = useRouter();
  const [creating, setCreating] = React.useState(false);
  const [busyId, setBusyId] = React.useState<number | null>(null);
  const [busyAction, setBusyAction] = React.useState<'archive' | 'restore' | 'delete' | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);

  const withBusy = async (
    goalId: number,
    action: 'archive' | 'restore' | 'delete',
    fn: () => Promise<{ ok: true } | { ok: false; error: string }>,
  ): Promise<boolean> => {
    setBusyId(goalId);
    setBusyAction(action);
    setActionError(null);
    try {
      const res = await fn();
      if (!res.ok) {
        setActionError(res.error);
        return false;
      }
      return true;
    } catch (e) {
      setActionError((e as Error).message ?? 'Operation failed');
      return false;
    } finally {
      setBusyId(null);
      setBusyAction(null);
    }
  };

  async function onArchive(id: number) {
    const ok = await withBusy(id, 'archive', () => archiveGoal(id));
    if (ok) router.refresh();
  }
  async function onUnarchive(id: number) {
    const ok = await withBusy(id, 'restore', () => unarchiveGoal(id));
    if (ok) router.refresh();
  }
  async function onDelete(id: number) {
    if (!confirm('Delete this goal? Linked positions stay; only the goal record is removed.'))
      return;
    const ok = await withBusy(id, 'delete', () => deleteGoal(id));
    if (ok) router.refresh();
  }

  const isBusy = (id: number, action: 'archive' | 'restore' | 'delete') =>
    busyId === id && busyAction === action;

  const goalActions = (g: GoalListItem): React.ReactElement => (
    <div className="grid grid-cols-2 gap-2 text-xs">
      {g.archivedAt ? (
        <button
          onClick={() => onUnarchive(g.id)}
          disabled={busyId === g.id}
          className="min-h-11 rounded border border-white/[0.08] px-3 py-2 text-zinc-300 hover:bg-white/[0.04] disabled:opacity-50"
        >
          {isBusy(g.id, 'restore') ? 'Restoring…' : 'Restore'}
        </button>
      ) : (
        <button
          onClick={() => onArchive(g.id)}
          disabled={busyId === g.id}
          className="min-h-11 rounded border border-white/[0.08] px-3 py-2 text-zinc-300 hover:bg-white/[0.04] disabled:opacity-50"
        >
          {isBusy(g.id, 'archive') ? 'Archiving…' : 'Archive'}
        </button>
      )}
      <button
        onClick={() => onDelete(g.id)}
        disabled={busyId === g.id}
        className="min-h-11 rounded border border-rose-500/30 px-3 py-2 text-rose-300 hover:bg-rose-500/10 disabled:opacity-50"
      >
        {isBusy(g.id, 'delete') ? 'Deleting…' : 'Delete'}
      </button>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3 text-xs text-zinc-400">
          <Link
            href={showArchived ? '/goals' : '/goals?archived=1'}
            className="inline-flex min-h-11 items-center rounded border border-white/[0.08] px-3 py-2 hover:bg-white/[0.04]"
          >
            {showArchived ? 'Hide archived' : 'Show archived'}
          </Link>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {actionError ? (
            <div className="rounded border border-rose-500/30 bg-rose-500/5 p-2 text-xs text-rose-300">
              {actionError}
            </div>
          ) : null}
          <button
            onClick={() => setCreating((v) => !v)}
            className="min-h-11 rounded bg-emerald-500/20 px-4 py-2 text-sm font-medium text-emerald-300 hover:bg-emerald-500/30"
          >
            {creating ? 'Cancel' : '+ New Goal'}
          </button>
        </div>
      </div>

      {creating ? (
        <div className="[&_button]:min-h-11 [&_input]:min-h-11 [&_input]:text-base [&_select]:min-h-11 [&_select]:text-base sm:[&_input]:text-sm sm:[&_select]:text-sm">
          <NewGoalForm accounts={accounts} onCancel={() => setCreating(false)} />
        </div>
      ) : null}

      <div className="space-y-3 md:hidden">
        {goals.length === 0 ? (
          <div className="rounded-lg border border-white/[0.06] px-4 py-8 text-center text-sm text-zinc-500">
            {showArchived
              ? 'No archived goals yet. Hide archived to view active goals.'
              : 'No goals yet. Add your first goal above.'}
          </div>
        ) : (
          goals.map((g) => (
            <article
              key={g.id}
              className={
                'rounded-lg border border-white/[0.06] bg-zinc-950/40 p-4 ' +
                (g.archivedAt ? 'opacity-60' : '')
              }
            >
              <div className="flex min-w-0 items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link
                    href={'/goals/' + g.id}
                    className="inline-flex min-h-11 max-w-full items-center break-words text-base font-medium hover:underline"
                  >
                    {g.name}
                  </Link>
                  <div className="mt-1 text-xs text-zinc-500">
                    {g.account?.name ?? 'No account assigned'}
                  </div>
                </div>
                <div className="shrink-0 pt-2">
                  <GoalBadge type={g.type} compact />
                </div>
              </div>

              <div className="mt-4">
                <GoalProgressBar
                  compact
                  currentCad={g.progress.currentValueCad}
                  targetCad={g.progress.targetCad}
                  percentComplete={g.progress.percentComplete}
                  onTrack={g.progress.onTrack}
                  targetDate={g.targetDate}
                />
              </div>

              <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <div>
                  <dt className="text-[11px] uppercase tracking-wider text-zinc-500">Target</dt>
                  <dd className="mt-0.5 font-mono text-xs">{cadFmt(g.targetAmountCad)}</dd>
                </div>
                <div>
                  <dt className="text-[11px] uppercase tracking-wider text-zinc-500">
                    Target date
                  </dt>
                  <dd className="mt-0.5 font-mono text-xs">
                    {g.targetDate ? dateFmt(g.targetDate) : '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] uppercase tracking-wider text-zinc-500">Current</dt>
                  <dd className="mt-0.5 font-mono text-xs">{cadFmt(g.progress.currentValueCad)}</dd>
                </div>
                <div>
                  <dt className="text-[11px] uppercase tracking-wider text-zinc-500">Positions</dt>
                  <dd className="mt-0.5 font-mono text-xs">{g.linkedPositionCount}</dd>
                </div>
              </dl>

              <div className="mt-4 border-t border-white/[0.06] pt-3">{goalActions(g)}</div>
            </article>
          ))
        )}
      </div>

      <div className="hidden overflow-x-auto rounded-lg border border-white/[0.06] md:block">
        <table className="w-full text-sm">
          <thead className="bg-white/[0.04] text-left text-xs uppercase tracking-wider text-zinc-400">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2 text-right">Target</th>
              <th className="hidden px-3 py-2 sm:table-cell">Date</th>
              <th className="px-3 py-2">Progress</th>
              <th className="hidden px-3 py-2 sm:table-cell">Account</th>
              <th className="hidden px-3 py-2 text-right sm:table-cell">Positions</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.04]">
            {goals.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-zinc-500">
                  {showArchived
                    ? 'No archived goals yet. Uncheck "Show archived" to view active goals.'
                    : 'No goals yet. Click "+ New Goal" to add one.'}
                </td>
              </tr>
            ) : (
              goals.map((g) => (
                <tr key={g.id} className={g.archivedAt ? 'opacity-50' : ''}>
                  <td className="px-3 py-2">
                    <Link href={'/goals/' + g.id} className="font-medium hover:underline">
                      {g.name}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    <GoalBadge type={g.type} compact />
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs">
                    {cadFmt(g.targetAmountCad)}
                  </td>
                  <td className="hidden px-3 py-2 font-mono text-xs text-zinc-400 sm:table-cell">
                    {g.targetDate ? dateFmt(g.targetDate) : '—'}
                  </td>
                  <td className="px-3 py-2">
                    <GoalProgressBar
                      compact
                      currentCad={g.progress.currentValueCad}
                      targetCad={g.progress.targetCad}
                      percentComplete={g.progress.percentComplete}
                      onTrack={g.progress.onTrack}
                      targetDate={g.targetDate}
                    />
                  </td>
                  <td className="hidden px-3 py-2 text-xs text-zinc-400 sm:table-cell">
                    {g.account ? `${g.account.name}` : <span className="text-zinc-600">—</span>}
                  </td>
                  <td className="hidden px-3 py-2 text-right font-mono text-xs sm:table-cell">
                    {g.linkedPositionCount}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex justify-end gap-1.5 text-xs">
                      {g.archivedAt ? (
                        <button
                          onClick={() => onUnarchive(g.id)}
                          disabled={busyId === g.id}
                          className="rounded border border-white/[0.08] px-2 py-0.5 text-zinc-300 hover:bg-white/[0.04]"
                        >
                          {isBusy(g.id, 'restore') ? 'Restoring…' : 'Restore'}
                        </button>
                      ) : (
                        <button
                          onClick={() => onArchive(g.id)}
                          disabled={busyId === g.id}
                          className="rounded border border-white/[0.08] px-2 py-0.5 text-zinc-300 hover:bg-white/[0.04]"
                        >
                          {isBusy(g.id, 'archive') ? 'Archiving…' : 'Archive'}
                        </button>
                      )}
                      <button
                        onClick={() => onDelete(g.id)}
                        disabled={busyId === g.id}
                        className="rounded border border-rose-500/30 px-2 py-0.5 text-rose-300 hover:bg-rose-500/10"
                      >
                        {isBusy(g.id, 'delete') ? 'Deleting…' : 'Delete'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
