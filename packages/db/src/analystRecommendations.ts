/**
 * AnalystRecommendation CRUD helpers — Phase 17.
 *
 * Populated by `apps/worker/src/jobs/pollAnalysts.ts` from Finnhub
 * `/stock/recommendation`. One row per (ticker, period) with strongBuy /
 * buy / hold / sell / strongSell counts.
 *
 * Read by:
 *   - packages/core/src/discover/analystUpgrades.ts (upgrade detector)
 */

import type { AnalystRecommendation } from '@prisma/client';
import { prisma } from './client.js';

export interface UpsertAnalystRecommendationInput {
  ticker: string;
  /** First-of-month timestamp the rec aggregate covers (Finnhub `period`). */
  period: Date;
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
}

export interface UpsertAnalystRecommendationsResult {
  upsertedCount: number;
}

/**
 * Bulk upsert recommendation rows on the (ticker, period) unique key.
 * Refreshes the existing row's count fields if the values change.
 */
export async function upsertAnalystRecommendations(
  rows: readonly UpsertAnalystRecommendationInput[],
): Promise<UpsertAnalystRecommendationsResult> {
  if (rows.length === 0) return { upsertedCount: 0 };

  for (const r of rows) {
    const ticker = r.ticker.toUpperCase();
    await prisma.analystRecommendation.upsert({
      where: {
        ticker_period: { ticker, period: r.period },
      },
      create: {
        ticker,
        period: r.period,
        strongBuy: r.strongBuy,
        buy: r.buy,
        hold: r.hold,
        sell: r.sell,
        strongSell: r.strongSell,
      },
      update: {
        strongBuy: r.strongBuy,
        buy: r.buy,
        hold: r.hold,
        sell: r.sell,
        strongSell: r.strongSell,
        fetchedAt: new Date(),
      },
    });
  }
  return { upsertedCount: rows.length };
}

/**
 * Two most-recent recommendation rows for a ticker, newest first. The
 * upgrade detector compares index 0 to index 1 to look for tier shifts.
 */
export function getLatestPair(
  ticker: string,
): Promise<AnalystRecommendation[]> {
  return prisma.analystRecommendation.findMany({
    where: { ticker: ticker.toUpperCase() },
    orderBy: { period: 'desc' },
    take: 2,
  });
}
