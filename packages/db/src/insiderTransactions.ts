/**
 * InsiderTransaction CRUD helpers — Phase 17.
 *
 * Populated by `apps/worker/src/jobs/pollInsiders.ts` from Finnhub
 * `/stock/insider-transactions`. Filtered to transaction code 'P'
 * (open-market purchases) at the poller level — option exercises ('M'),
 * grants, and sells are dropped before write.
 *
 * Read by:
 *   - packages/core/src/discover/insiderCluster.ts (cluster detector)
 *
 * Note: the pre-existing discovery scorer
 * (packages/core/src/discover/signals.ts) reads insider data DIRECTLY from
 * Finnhub per-ticker — it has no dependency on this table. We keep the two
 * paths separate so the catalyst engine can rely on a stable, deduped
 * historical record, while the discovery scorer continues to use a fresh
 * 90d window per nightly compute pass.
 */

import type { InsiderTransaction, Prisma } from '@prisma/client';
import { prisma } from './client.js';

export interface UpsertInsiderTransactionInput {
  ticker: string;
  insiderName: string;
  insiderTitle?: string | null;
  transactionDate: Date;
  transactionCode: string;
  /** Share count for this transaction (always positive). */
  shares: number | string | Prisma.Decimal;
  /** Reported price per share. */
  pricePerShare: number | string | Prisma.Decimal;
  /** USD value (shares × pricePerShare). Caller computes; we trust. */
  valueUsd: number | string | Prisma.Decimal;
  filingDate: Date;
  source?: string;
}

export interface UpsertInsiderTransactionsResult {
  upsertedCount: number;
  newCount: number;
}

/**
 * Bulk upsert insider transactions on the unique key
 * (ticker, insiderName, transactionDate, shares). Tracks which rows were
 * NEW (no prior record) so the poller can return a `newPurchasesDetected`
 * count for downstream cluster detection.
 */
export async function upsertInsiderTransactions(
  rows: readonly UpsertInsiderTransactionInput[],
): Promise<UpsertInsiderTransactionsResult> {
  if (rows.length === 0) return { upsertedCount: 0, newCount: 0 };

  let newCount = 0;
  let upsertedCount = 0;

  // Per-row upsert in a transaction — same tradeoff as upsertBars: ~tens of
  // rows per ticker, well inside Postgres / Prisma budget. The composite
  // unique key prevents createMany from being a clean fit.
  for (const r of rows) {
    const ticker = r.ticker.toUpperCase();
    const existing = await prisma.insiderTransaction.findUnique({
      where: {
        ticker_insiderName_transactionDate_shares: {
          ticker,
          insiderName: r.insiderName,
          transactionDate: r.transactionDate,
          shares: r.shares as Prisma.Decimal,
        },
      },
      select: { id: true },
    });
    await prisma.insiderTransaction.upsert({
      where: {
        ticker_insiderName_transactionDate_shares: {
          ticker,
          insiderName: r.insiderName,
          transactionDate: r.transactionDate,
          shares: r.shares as Prisma.Decimal,
        },
      },
      create: {
        ticker,
        insiderName: r.insiderName,
        insiderTitle: r.insiderTitle ?? null,
        transactionDate: r.transactionDate,
        transactionCode: r.transactionCode,
        shares: r.shares as Prisma.Decimal,
        pricePerShare: r.pricePerShare as Prisma.Decimal,
        valueUsd: r.valueUsd as Prisma.Decimal,
        filingDate: r.filingDate,
        source: r.source ?? 'finnhub',
      },
      update: {
        // Only re-touch the volatile fields on an upsert hit. The unique key
        // pins the txn identity so the rest is informational.
        insiderTitle: r.insiderTitle ?? null,
        transactionCode: r.transactionCode,
        pricePerShare: r.pricePerShare as Prisma.Decimal,
        valueUsd: r.valueUsd as Prisma.Decimal,
        filingDate: r.filingDate,
      },
    });
    upsertedCount++;
    if (!existing) newCount++;
  }

  return { upsertedCount, newCount };
}

/**
 * Fetch all open-market insider purchases for a ticker after `since`. Used
 * by the cluster detector to gather the candidate buy window.
 */
export function listPurchasesSince(
  ticker: string,
  since: Date,
): Promise<InsiderTransaction[]> {
  return prisma.insiderTransaction.findMany({
    where: {
      ticker: ticker.toUpperCase(),
      transactionDate: { gte: since },
      transactionCode: 'P',
    },
    orderBy: { transactionDate: 'asc' },
  });
}

/**
 * Distinct ticker symbols that have at least one purchase since the given
 * date. Used by the cluster detector as the input to `detectClusters` so
 * we don't iterate an empty universe.
 */
export async function distinctPurchasedTickersSince(
  since: Date,
): Promise<string[]> {
  const rows = await prisma.insiderTransaction.findMany({
    where: {
      transactionDate: { gte: since },
      transactionCode: 'P',
    },
    distinct: ['ticker'],
    select: { ticker: true },
  });
  return rows.map((r) => r.ticker.toUpperCase());
}
