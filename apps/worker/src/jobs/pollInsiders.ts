/**
 * Poll Finnhub insider transactions — Phase 17.1.
 *
 * For each held + watchlist + top-100 discovery ticker:
 *   - Pull insider transactions from the last 7 days via
 *     `FinnhubAdapter.getInsiderPurchases` (already filtered to code 'P').
 *   - Upsert into the InsiderTransaction table.
 *   - Run the cluster detector against the freshly written rows.
 *   - Emit one InsiderCluster MarketEvent per ticker that crosses the
 *     conviction threshold, deduped against the same (ticker,
 *     firstBuyDate) within the last 7d.
 *
 * Runs every 30 minutes during market hours (`*\/30 9-16 * * 1-5`).
 *
 * Rate-limit safety: Finnhub is 60/min; the FinnhubAdapter owns its own
 * limiter so we don't need to pace per-call here. We do, however, cap the
 * universe at ~120 tickers per run (held + watchlist + top-100) so a
 * single tick stays well under the 60/min budget.
 */

import {
  prisma,
  upsertInsiderTransactions,
  listPurchasesSince,
  distinctPurchasedTickersSince,
  createMarketEvent,
  EventKind,
  type Prisma,
} from '@vantage/db';
import { detectClusters, type ClusterEvent } from '@vantage/core';
import { getFinnhub } from '../lib/adapters.js';
import { buildCatalystUniverse } from '../lib/catalystUniverse.js';
import type { FastifyBaseLogger } from 'fastify';

export interface PollInsidersResult {
  tickersChecked: number;
  txnsFetched: number;
  newPurchasesDetected: number;
  clustersEmitted: number;
  failedTickers: string[];
}

/**
 * Persist a single ClusterEvent as a MarketEvent kind=InsiderCluster.
 * Dedups against any same-ticker InsiderCluster MarketEvent created within
 * the last 7d that shares a `firstBuyDate` payload field.
 */
async function emitClusterEvent(event: ClusterEvent): Promise<boolean> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const firstBuyIso = event.firstBuyDate.toISOString();

  const existing = await prisma.marketEvent.findFirst({
    where: {
      kind: EventKind.InsiderCluster,
      ticker: event.ticker,
      createdAt: { gte: sevenDaysAgo },
      payload: {
        path: ['firstBuyDate'],
        equals: firstBuyIso,
      },
    },
    select: { id: true },
  });
  if (existing) return false;

  const payload: Prisma.InputJsonValue = {
    distinctInsiders: event.distinctInsiders,
    totalUsd: event.totalUsd,
    conviction: event.conviction,
    directorCount: event.directorCount,
    insiders: event.insiders.map((i) => ({
      insiderName: i.insiderName,
      insiderTitle: i.insiderTitle,
      shares: i.shares,
      pricePerShare: i.pricePerShare,
      valueUsd: i.valueUsd,
      transactionDate: i.transactionDate.toISOString(),
    })),
    firstBuyDate: firstBuyIso,
    lastBuyDate: event.lastBuyDate.toISOString(),
  };
  await createMarketEvent({
    kind: EventKind.InsiderCluster,
    ticker: event.ticker,
    occurredAt: event.lastBuyDate,
    payload,
  });
  return true;
}

export async function pollInsiders(
  log: FastifyBaseLogger | Console = console,
): Promise<PollInsidersResult> {
  const universe = await buildCatalystUniverse({ limit: 200 });
  const failed: string[] = [];
  let txnsFetched = 0;
  let newPurchasesDetected = 0;
  let clustersEmitted = 0;

  if (universe.length === 0) {
    return {
      tickersChecked: 0,
      txnsFetched: 0,
      newPurchasesDetected: 0,
      clustersEmitted: 0,
      failedTickers: [],
    };
  }

  const fn = getFinnhub();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  for (const ticker of universe) {
    try {
      const purchases = await fn.getInsiderPurchases(ticker);
      txnsFetched += purchases.length;
      // Filter to last-7d window — Finnhub returns the trailing 6 months.
      const recent = purchases.filter(
        (p) => p.transactionDate.getTime() >= sevenDaysAgo.getTime(),
      );
      if (recent.length === 0) continue;
      const upsert = await upsertInsiderTransactions(
        recent.map((p) => ({
          ticker,
          insiderName: p.insiderName,
          insiderTitle: p.insiderTitle,
          transactionDate: p.transactionDate,
          transactionCode: p.transactionCode,
          shares: p.shares,
          pricePerShare: p.pricePerShare,
          valueUsd: p.valueUsd,
          filingDate: p.filingDate,
          source: 'finnhub',
        })),
      );
      newPurchasesDetected += upsert.newCount;
    } catch (err) {
      log.warn?.(
        { ticker, err: err instanceof Error ? err.message : err },
        'pollInsiders: ticker fetch failed',
      );
      failed.push(ticker);
    }
  }

  // Cluster detection — pull all tickers with purchases in the window and
  // run the detector once per ticker. We re-load from the DB rather than
  // reusing the in-memory rows above so dedup happens across runs.
  const clusterTickers = await distinctPurchasedTickersSince(sevenDaysAgo);
  for (const ticker of clusterTickers) {
    if (!universe.includes(ticker)) continue;
    try {
      const txns = await listPurchasesSince(ticker, sevenDaysAgo);
      if (txns.length === 0) continue;
      const events = detectClusters(txns, { sinceHours: 7 * 24 });
      for (const ev of events) {
        const emitted = await emitClusterEvent(ev);
        if (emitted) clustersEmitted++;
      }
    } catch (err) {
      log.warn?.(
        { ticker, err: err instanceof Error ? err.message : err },
        'pollInsiders: cluster detect failed',
      );
    }
  }

  return {
    tickersChecked: universe.length,
    txnsFetched,
    newPurchasesDetected,
    clustersEmitted,
    failedTickers: failed,
  };
}
