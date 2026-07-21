/**
 * AccountPicker — `<select>` that lists non-archived accounts as
 * "{name} ({type})". Persists the last-used choice in localStorage under the
 * key "vantage:last-account" so the add-position drawer + bulk import
 * default to the right account on next visit.
 */

'use client';

import * as React from 'react';
import type { AccountListItem } from '@/app/(dashboard)/accounts/data';

const LAST_USED_KEY = 'vantage:last-account';

interface AccountPickerProps {
  accounts: AccountListItem[];
  value: number | null;
  onChange: (id: number) => void;
  label?: string;
  /** When true, persist the picked value to localStorage on change. */
  rememberSelection?: boolean;
  /** Optional hint rendered below the select (e.g. account-suggestion text). */
  hint?: React.ReactNode;
  disabled?: boolean;
}

function readLastUsed(): number | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(LAST_USED_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function writeLastUsed(id: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LAST_USED_KEY, String(id));
  } catch {
    /* swallow */
  }
}

export function AccountPicker({
  accounts,
  value,
  onChange,
  label = 'Account',
  rememberSelection = true,
  hint,
  disabled = false,
}: AccountPickerProps): React.ReactElement {
  // On first render, if no value is set, pick last-used from localStorage,
  // or fall back to the first non-archived account.
  React.useEffect(() => {
    if (value !== null) return;
    const active = accounts.filter((a) => !a.archivedAt);
    if (active.length === 0) return;
    const last = readLastUsed();
    const picked = (last && active.find((a) => a.id === last)?.id) ?? active[0]!.id;
    onChange(picked);
  }, [accounts, onChange, value]);

  const handle = (id: number) => {
    if (rememberSelection) writeLastUsed(id);
    onChange(id);
  };

  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
        {label}
      </span>
      <select
        value={value ?? ''}
        onChange={(e) => handle(Number(e.target.value))}
        disabled={disabled || accounts.length === 0}
        className="cc-input"
        required
      >
        {accounts.length === 0 && <option value="">No accounts yet</option>}
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name} ({a.type}){a.archivedAt ? ' · archived' : ''}
          </option>
        ))}
      </select>
      {hint && <span className="font-mono text-[10px] text-muted-foreground/70">{hint}</span>}
    </label>
  );
}

export { LAST_USED_KEY as ACCOUNT_PICKER_STORAGE_KEY };
