/**
 * Poll Finnhub analyst recommendation trends — Phase 17.4.
 *
 * Fires once per trading day pre-market (`0 7 * * 1-5`). For each held +
 * watchlist + top-100 discovery ticker:
 *   - Fetch /stock/recommendation (returns one row per month).
 *   - Upsert all returned rows into AnalystRecommendation.
 *   - Run `detectUpgrade` on the latest two rows.
 *   - Emit AnalystUpgrade MarketEvent when the detector returns a hit,
 *     deduped against (ticker, period-month).
 */

import {
  prisma,
  upsertAnalystRecommendations,
  getLatestPair,
  createMarketEvent,
  EventKind,
  type Prisma,
} from '@vantage/db';
import { detectUpgrade, type UpgradeEvent } from '@vantage/core';
import { getFinnhub } from '../lib/adapters.js';
import { buildCatalystUniverse } from '../lib/catalystUniverse.js';
import type { FastifyBaseLogger } from 'fastify';

export interface PollAnalystsResult {
  tickersChecked: number;
  rowsUpserted: number;
  upgradesEmitted: number;
  failedTickers: string[];
}

function periodToMonthKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/**
 * Persist one UpgradeEvent as a MarketEvent kind=AnalystUpgrade. Dedups
 * against any prior AnalystUpgrade for the same ticker + period-month.
 */
async function emitUpgradeEvent(event: UpgradeEvent): Promise<boolean> {
  const monthKey = periodToMonthKey(event.period);
  const existing = await prisma.marketEvent.findFirst({
    where: {
      kind: EventKind.AnalystUpgrade,
      ticker: event.ticker,
      payload: {
        path: ['monthKey'],
        equals: monthKey,
      },
    },
    select: { id: true },
  });
  if (existing) return false;

  const payload: Prisma.InputJsonValue = {
    deltaStrongBuy: event.deltaStrongBuy,
    deltaBuy: event.deltaBuy,
    fromConsensus: event.fromConsensus,
    toConsensus: event.toConsensus,
    period: event.period.toISOString(),
    monthKey,
  };
  await createMarketEvent({
    kind: EventKind.AnalystUpgrade,
    ticker: event.ticker,
    occurredAt: event.period,
    payload,
  });
  return true;
}

export async function pollAnalysts(
  log: FastifyBaseLogger | Console = console,
): Promise<PollAnalystsResult> {
  const universe = await buildCatalystUniverse({ limit: 200 });
  const failed: string[] = [];
  let rowsUpserted = 0;
  let upgradesEmitted = 0;

  if (universe.length === 0) {
    return {
      tickersChecked: 0,
      rowsUpserted: 0,
      upgradesEmitted: 0,
      failedTickers: [],
    };
  }

  const fn = getFinnhub();

  for (const ticker of universe) {
    try {
      const trends = await fn.getRecommendationTrends(ticker);
      if (trends.length === 0) continue;

      const upsertRows = trends.map((t) => {
        const period = new Date(t.period);
        return {
          ticker,
          period,
          strongBuy: Number.isFinite(Number(t.strongBuy)) ? Number(t.strongBuy) : 0,
          buy: Number.isFinite(Number(t.buy)) ? Number(t.buy) : 0,
          hold: Number.isFinite(Number(t.hold)) ? Number(t.hold) : 0,
          sell: Number.isFinite(Number(t.sell)) ? Number(t.sell) : 0,
          strongSell: Number.isFinite(Number(t.strongSell))
            ? Number(t.strongSell)
            : 0,
        };
      });
      const upsert = await upsertAnalystRecommendations(upsertRows);
      rowsUpserted += upsert.upsertedCount;

      // Detect upgrade from the freshly stored two-row pair.
      const pair = await getLatestPair(ticker);
      const event = detectUpgrade(pair);
      if (event) {
        const emitted = await emitUpgradeEvent(event);
        if (emitted) upgradesEmitted++;
      }
    } catch (err) {
      log.warn?.(
        { ticker, err: err instanceof Error ? err.message : err },
        'pollAnalysts: ticker fetch failed',
      );
      failed.push(ticker);
    }
  }

  return {
    tickersChecked: universe.length,
    rowsUpserted,
    upgradesEmitted,
    failedTickers: failed,
  };
}
