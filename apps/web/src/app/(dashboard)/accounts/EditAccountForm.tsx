/**
 * EditAccountForm — pre-populated client form for editing an existing Account.
 *
 * Mirrors NewAccountForm but also exposes Archive / Unarchive controls. Type
 * is editable; the server action is the one that decides whether the
 * contribution-room column should be cleared on a type change.
 */

'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  archiveAccount,
  unarchiveAccount,
  updateAccount,
} from './actions';
import type { AccountListItem } from './data';

type AccountType =
  | 'TFSA'
  | 'RRSP'
  | 'SpousalRRSP'
  | 'RESP'
  | 'LIRA'
  | 'RRIF'
  | 'Personal'
  | 'Margin'
  | 'Corporate';

const TYPES: AccountType[] = [
  'TFSA',
  'RRSP',
  'SpousalRRSP',
  'RESP',
  'LIRA',
  'RRIF',
  'Personal',
  'Margin',
  'Corporate',
];

const TYPES_WITH_ROOM: AccountType[] = ['TFSA', 'RRSP', 'SpousalRRSP', 'RRIF'];

export function EditAccountForm({
  account,
  onDone,
}: {
  account: AccountListItem;
  onDone?: () => void;
}): React.ReactElement {
  const router = useRouter();
  const [name, setName] = React.useState(account.name);
  const [type, setType] = React.useState<AccountType>(account.type);
  const [currency, setCurrency] = React.useState<'CAD' | 'USD'>(
    account.currency === 'USD' ? 'USD' : 'CAD',
  );
  const [broker, setBroker] = React.useState(account.broker);
  const [room, setRoom] = React.useState(
    account.contributionRoomCad === null
      ? ''
      : String(account.contributionRoomCad),
  );
  const [submitting, setSubmitting] = React.useState(false);
  const [archiving, setArchiving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const showRoom = TYPES_WITH_ROOM.includes(type);
  const isArchived = account.archivedAt !== null;

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setSubmitting(false);
      setError('name is required');
      return;
    }
    const roomNum = showRoom && room.trim() !== '' ? Number(room) : null;
    if (roomNum !== null && (!Number.isFinite(roomNum) || roomNum < 0)) {
      setSubmitting(false);
      setError('contribution room must be a positive number');
      return;
    }
    const result = await updateAccount(account.id, {
      name: trimmed,
      type,
      currency,
      broker: broker.trim() || 'Wealthsimple',
      contributionRoomCad: roomNum,
    });
    setSubmitting(false);
    if (!result.ok) {
      setError(result.error ?? 'unexpected error');
      return;
    }
    if (onDone) onDone();
    router.refresh();
  };

  const doArchive = async () => {
    if (
      !window.confirm(
        isArchived
          ? `Restore "${account.name}" so positions can be opened here again?`
          : `Archive "${account.name}"? Existing positions remain but the account is hidden from default views.`,
      )
    ) {
      return;
    }
    setArchiving(true);
    setError(null);
    const result = isArchived
      ? await unarchiveAccount(account.id)
      : await archiveAccount(account.id);
    setArchiving(false);
    if (!result.ok) {
      setError(result.error ?? 'unexpected error');
      return;
    }
    if (onDone) onDone();
    router.refresh();
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="cc-input"
            required
          />
        </Field>
        <Field label="Type">
          <select
            value={type}
            onChange={(e) => setType(e.target.value as AccountType)}
            className="cc-input"
          >
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Currency">
          <div className="flex gap-3 pt-1.5">
            {(['CAD', 'USD'] as const).map((c) => (
              <label
                key={c}
                className="inline-flex cursor-pointer items-center gap-2 font-mono text-xs text-foreground/80"
              >
                <input
                  type="radio"
                  name={`currency-${account.id}`}
                  value={c}
                  checked={currency === c}
                  onChange={() => setCurrency(c)}
                  className="size-3.5 accent-[var(--cc-accent)]"
                />
                {c}
              </label>
            ))}
          </div>
        </Field>
        <Field label="Broker">
          <input
            value={broker}
            onChange={(e) => setBroker(e.target.value)}
            className="cc-input"
          />
        </Field>
        {showRoom && (
          <Field label={`Contribution room (${currency})`}>
            <input
              value={room}
              onChange={(e) => setRoom(e.target.value)}
              type="number"
              step="0.01"
              inputMode="decimal"
              placeholder="optional"
              className="cc-input font-mono tabular-nums"
            />
          </Field>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 font-mono text-xs text-rose-300">
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.06] pt-5">
        <button
          type="button"
          onClick={doArchive}
          disabled={archiving || submitting}
          className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.2em] text-amber-300 transition hover:bg-amber-500/20 disabled:opacity-40"
        >
          {archiving
            ? 'Working…'
            : isArchived
              ? 'Restore account'
              : 'Archive account'}
        </button>
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md border border-[var(--cc-accent)]/30 bg-gradient-to-b from-[var(--cc-accent)]/20 to-transparent px-4 py-2 text-sm font-medium text-[var(--cc-accent)] transition hover:from-[var(--cc-accent)]/30 disabled:opacity-50"
        >
          {submitting ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </form>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}
