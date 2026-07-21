'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { linkPositionToGoal, unlinkPositionFromGoal, updateAllocation } from './actions';

export interface OpenPosition {
  id: number;
  ticker: string;
  accountId: number;
  accountName: string;
  shares: number;
}

export interface LinkedPosition {
  id: number;
  ticker: string;
  accountName: string;
  shares: number;
  allocation: number;
}

export function LinkPositionForm({
  goalId,
  openPositions,
  alreadyLinked,
  linkedPositions,
}: {
  goalId: number;
  openPositions: OpenPosition[];
  alreadyLinked: number[];
  linkedPositions: LinkedPosition[];
}): React.ReactElement {
  const router = useRouter();
  const candidates = openPositions.filter((p) => !alreadyLinked.includes(p.id));
  const [positionId, setPositionId] = React.useState<number | ''>(candidates[0]?.id ?? '');
  const [allocation, setAllocation] = React.useState(1.0);
  const [error, setError] = React.useState<string | null>(null);
  const [warning, setWarning] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [unlinkingId, setUnlinkingId] = React.useState<number | null>(null);
  const [editingPositionId, setEditingPositionId] = React.useState<number | null>(null);
  const [editingAllocation, setEditingAllocation] = React.useState<number>(1.0);
  const [updatingAllocationId, setUpdatingAllocationId] = React.useState<number | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (typeof positionId !== 'number') return;
    setSubmitting(true);
    setError(null);
    setWarning(null);
    const r = await linkPositionToGoal(positionId, goalId, allocation);
    setSubmitting(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    // The link itself succeeded; surface a non-blocking warning when this
    // position is now allocated past 100% across all of its goals.
    if (r.overAllocated) {
      setWarning(
        `This position is now allocated ${(r.totalAllocation * 100).toFixed(0)}% across your goals — over 100%.`,
      );
    }
    router.refresh();
  }

  async function onUnlink(pid: number) {
    if (!confirm('Unlink this position from the goal?')) return;
    setUnlinkingId(pid);
    setError(null);
    const r = await unlinkPositionFromGoal(pid, goalId);
    setUnlinkingId(null);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    router.refresh();
  }

  async function onUpdateAllocation(pid: number) {
    setUpdatingAllocationId(pid);
    setError(null);
    const r = await updateAllocation(pid, goalId, editingAllocation);
    setUpdatingAllocationId(null);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setEditingPositionId(null);
    router.refresh();
  }

  function onStartEdit(pid: number) {
    const linked = linkedPositions.find((p) => p.id === pid);
    if (!linked) return;
    setEditingPositionId(pid);
    setEditingAllocation(linked.allocation);
    setError(null);
  }

  function onCancelEdit() {
    setEditingPositionId(null);
    setEditingAllocation(1.0);
  }

  if (candidates.length === 0 && linkedPositions.length === 0) {
    return <div className="text-sm text-zinc-500">No open positions to link.</div>;
  }

  return (
    <div className="space-y-3">
      {candidates.length > 0 ? (
        <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
          <label className="space-y-1">
            <span className="block text-xs uppercase tracking-wider text-zinc-500">Position</span>
            <select
              value={positionId}
              onChange={(e) => setPositionId(Number(e.target.value))}
              className="rounded border border-white/[0.08] bg-black/40 px-3 py-1.5 text-sm font-mono"
            >
              {candidates.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.ticker} ({p.accountName})
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-xs uppercase tracking-wider text-zinc-500">
              Allocation
            </span>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min="0.05"
                max="1"
                step="0.05"
                value={allocation}
                onChange={(e) => setAllocation(Number(e.target.value))}
                className="w-32"
              />
              <span className="w-12 font-mono text-xs">{(allocation * 100).toFixed(0)}%</span>
            </div>
          </label>
          <button
            type="submit"
            disabled={submitting}
            className="rounded bg-emerald-500/20 px-3 py-1.5 text-sm text-emerald-300 hover:bg-emerald-500/30 disabled:opacity-50"
          >
            {submitting ? 'Linking…' : 'Link'}
          </button>
        </form>
      ) : null}
      {warning ? (
        <div className="rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-xs text-amber-300">
          {warning}
        </div>
      ) : null}
      {error ? <div className="text-xs text-rose-300">{error}</div> : null}
      {linkedPositions.length > 0 ? (
        <div className="text-xs text-zinc-500">
          Currently linked:{' '}
          {linkedPositions.map((p) => {
            const isEditing = editingPositionId === p.id;
            return (
              <span key={p.id} className="mr-2 inline-flex items-center gap-2">
                <button
                  onClick={() => onUnlink(p.id)}
                  disabled={unlinkingId === p.id}
                  className="rounded border border-white/[0.06] px-1.5 py-0.5 font-mono text-xs hover:border-rose-500/30 hover:text-rose-300 disabled:opacity-50"
                  title="Click to unlink"
                >
                  {unlinkingId === p.id ? '…' : `${p.ticker} ${(p.allocation * 100).toFixed(0)}% ×`}
                </button>
                {isEditing ? (
                  <span className="flex items-center gap-1.5 text-zinc-300">
                    <input
                      type="range"
                      min="0.05"
                      max="1"
                      step="0.05"
                      value={editingAllocation}
                      onChange={(e) => setEditingAllocation(Number(e.target.value))}
                      className="w-24"
                    />
                    <span className="w-10 font-mono text-xs">{(editingAllocation * 100).toFixed(0)}%</span>
                    <button
                      type="button"
                      onClick={() => onUpdateAllocation(p.id)}
                      disabled={updatingAllocationId === p.id}
                      className="rounded border border-emerald-500/30 px-1.5 py-0.5 text-[11px] text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-50"
                    >
                      {updatingAllocationId === p.id ? '…' : 'save'}
                    </button>
                    <button
                      type="button"
                      onClick={onCancelEdit}
                      className="rounded border border-white/[0.08] px-1.5 py-0.5 text-[11px] text-zinc-300 hover:bg-white/[0.04]"
                    >
                      cancel
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => onStartEdit(p.id)}
                    className="text-[11px] text-blue-300 underline decoration-dotted underline-offset-2 hover:text-blue-200"
                  >
                    edit allocation
                  </button>
                )}
              </span>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
