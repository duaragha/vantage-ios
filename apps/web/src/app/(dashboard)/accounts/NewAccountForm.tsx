/**
 * NewAccountForm — client form for creating an Account.
 *
 * Contribution-room field is only shown for registered-room account types
 * (TFSA / RRSP / SpousalRRSP / RRIF). Personal, Margin, Corporate, RESP,
 * LIRA hide the field.
 */

'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { createAccount } from './actions';

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

export function NewAccountForm({
  onDone,
}: {
  onDone?: () => void;
}): React.ReactElement {
  const router = useRouter();
  const [name, setName] = React.useState('');
  const [type, setType] = React.useState<AccountType>('TFSA');
  const [currency, setCurrency] = React.useState<'CAD' | 'USD'>('CAD');
  const [broker, setBroker] = React.useState('Wealthsimple');
  const [room, setRoom] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const showRoom = TYPES_WITH_ROOM.includes(type);

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
    const result = await createAccount({
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

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Wealthsimple TFSA"
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
                  name="currency"
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
              placeholder="optional — current CRA room"
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

      <div className="flex items-center justify-end gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="relative overflow-hidden rounded-md border border-[var(--cc-accent)]/30 bg-gradient-to-b from-[var(--cc-accent)]/20 to-transparent px-4 py-2 text-sm font-medium text-[var(--cc-accent)] transition hover:from-[var(--cc-accent)]/30 disabled:opacity-50"
        >
          {submitting ? 'Saving…' : 'Create account'}
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
