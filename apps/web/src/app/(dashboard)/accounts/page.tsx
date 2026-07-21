/**
 * /accounts — sub-account management.
 *
 * Server component. Toggles include-archived off the `archived=1` URL param
 * so the page re-renders cleanly (vs. client-side filtering, which would
 * require a separate fetch path).
 */

import * as React from 'react';
import { StatusDot } from '@/components/StatusDot';
import { listAccounts, type AccountListItem } from './data';
import { AccountsTable } from './AccountsTable';
import { DbErrorBanner } from '@/components/DbErrorBanner';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ archived?: string }>;
}

export default async function AccountsPage({
  searchParams,
}: PageProps): Promise<React.ReactElement> {
  const sp = await searchParams;
  const includeArchived = sp.archived === '1';

  let accounts: AccountListItem[] = [];
  let dbError: string | null = null;
  try {
    accounts = await listAccounts({ includeArchived });
  } catch (err) {
    dbError = err instanceof Error ? err.message : 'database unreachable';
  }

  const liveCount = accounts.filter((a) => a.archivedAt === null).length;
  const archivedCount = accounts.length - liveCount;

  return (
    <div className="cc-page">
      <header className="cc-page-header">
        <div>
          <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
            <StatusDot status="fresh" />
            accounts
          </div>
          <h1 className="cc-page-title">Sub-accounts</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {accounts.length === 0
              ? 'No accounts yet. Add one to start tagging positions.'
              : `${liveCount} active${
                  includeArchived && archivedCount > 0 ? ` · ${archivedCount} archived` : ''
                }.`}
          </p>
        </div>
      </header>

      <DbErrorBanner message={dbError} />

      <AccountsTable accounts={accounts} showArchived={includeArchived} />
    </div>
  );
}
