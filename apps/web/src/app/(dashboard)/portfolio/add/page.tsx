/**
 * /portfolio/add — pre-filled Position form.
 *
 * Used by the Bought flow. Accepts `?fromInsight=<id>&ticker=AAPL&shares=10&priceSnapshot=123.45`.
 */

import * as React from 'react';
import { FrostedPanel } from '@/components/FrostedPanel';
import { PositionForm, type PositionFormPrefill } from '@/components/PositionForm';
import { listAccounts, type AccountListItem } from '@/app/(dashboard)/accounts/data';
import { DbErrorBanner } from '@/components/DbErrorBanner';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{
    fromInsight?: string;
    ticker?: string;
    shares?: string;
    priceSnapshot?: string;
    currency?: string;
    category?: string;
    accountId?: string;
  }>;
}

export default async function AddPositionPage({
  searchParams,
}: PageProps): Promise<React.ReactElement> {
  const sp = await searchParams;
  let accounts: AccountListItem[] = [];
  let dbError: string | null = null;
  try {
    accounts = await listAccounts({ includeArchived: false });
  } catch (err) {
    accounts = [];
    dbError = err instanceof Error ? err.message : 'database unreachable';
  }
  const prefill: PositionFormPrefill = {
    ticker: sp.ticker?.toUpperCase(),
    shares: sp.shares,
    avgCost: sp.priceSnapshot,
    currency: sp.currency === 'CAD' ? 'CAD' : sp.currency === 'USD' ? 'USD' : undefined,
    category: sp.category,
    ...(sp.accountId && /^\d+$/.test(sp.accountId) ? { accountId: Number(sp.accountId) } : {}),
    ...(sp.fromInsight && /^\d+$/.test(sp.fromInsight)
      ? { fromInsightId: Number(sp.fromInsight) }
      : {}),
  };
  return (
    <div className="cc-page-narrow max-w-3xl">
      <header className="mb-8">
        <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
          {prefill.fromInsightId
            ? `prefilled from insight #${prefill.fromInsightId}`
            : 'add position'}
        </div>
        <h1 className="cc-page-title">
          {prefill.fromInsightId ? 'Confirm the buy' : 'New position'}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {prefill.fromInsightId
            ? 'The insight has been pre-filled. Confirm the exact shares + price you executed.'
            : 'Adds a Position row and (optionally) a structured Thesis.'}
        </p>
      </header>

      <DbErrorBanner message={dbError} />

      <FrostedPanel padding="lg">
        <PositionForm mode="create" prefill={prefill} accounts={accounts} />
      </FrostedPanel>
    </div>
  );
}
