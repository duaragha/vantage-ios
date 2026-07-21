/**
 * /portfolio/import — CSV paste → preview → confirm.
 *
 * Server entrypoint renders the client form. Validation + upsert happens via
 * the `bulkImportPositions` server action.
 */

import * as React from 'react';
import { FrostedPanel } from '@/components/FrostedPanel';
import { listOpenPositions } from '@vantage/db';
import { listAccounts, type AccountListItem } from '@/app/(dashboard)/accounts/data';
import { BulkImportForm } from './BulkImportForm';
import { DbErrorBanner } from '@/components/DbErrorBanner';

export const dynamic = 'force-dynamic';

export default async function ImportPage(): Promise<React.ReactElement> {
  let existingTickers: string[] = [];
  let accounts: AccountListItem[] = [];
  let dbError: string | null = null;
  try {
    const [rows, accountRows] = await Promise.all([
      listOpenPositions(),
      listAccounts({ includeArchived: false }),
    ]);
    existingTickers = rows.map((r) => r.ticker);
    accounts = accountRows;
  } catch (err) {
    existingTickers = [];
    accounts = [];
    dbError = err instanceof Error ? err.message : 'database unreachable';
  }
  return (
    <div className="cc-page-narrow max-w-4xl">
      <header className="mb-8">
        <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
          bulk import
        </div>
        <h1 className="cc-page-title">Paste positions</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Columns: <code className="font-mono">ticker, shares, avg_cost, category</code>. Header row
          optional. Category defaults to Other. All rows land in the selected account.
        </p>
      </header>
      <DbErrorBanner message={dbError} />
      <FrostedPanel padding="lg">
        <BulkImportForm existingTickers={existingTickers} accounts={accounts} />
      </FrostedPanel>
    </div>
  );
}
