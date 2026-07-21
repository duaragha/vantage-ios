/**
 * AccountFilter — dropdown that pushes `?accountId=N` (or removes it) so the
 * server-side data fetch picks up the filter on the next render.
 */

'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { AccountListItem } from '@/app/(dashboard)/accounts/data';

export function AccountFilter({
  accounts,
  selectedId,
}: {
  accounts: AccountListItem[];
  /** null = all, 'archived' = only archived. */
  selectedId: number | 'archived' | null;
}): React.ReactElement {
  const router = useRouter();
  const sp = useSearchParams();

  const onChange = (raw: string) => {
    const params = new URLSearchParams(sp.toString());
    if (raw === 'all') {
      params.delete('accountId');
    } else {
      params.set('accountId', raw);
    }
    const qs = params.toString();
    router.push(qs ? `/portfolio?${qs}` : '/portfolio');
  };

  const value =
    selectedId === null
      ? 'all'
      : selectedId === 'archived'
        ? 'archived'
        : String(selectedId);

  return (
    <label className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
      <span>Account</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-white/[0.08] bg-black/30 px-2 py-1.5 font-mono text-xs text-foreground outline-none focus:border-[var(--cc-accent)]/60"
      >
        <option value="all">All accounts</option>
        {accounts
          .filter((a) => a.archivedAt === null)
          .map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} ({a.type})
            </option>
          ))}
        <option value="archived">Archived</option>
      </select>
    </label>
  );
}
