/**
 * Centralized "what tickers should the catalyst pollers scan" helper —
 * unifies held + watchlist + (optional) top-N discovery so candidate names
 * generate catalyst events alongside owned positions.
 */

import { prisma, latestTopN } from '@vantage/db';
import { componentLogger } from '@vantage/notify';

const log = componentLogger('worker/catalyst-universe');

export interface CatalystUniverseOptions {
  /**
   * Cap on tickers returned. Default 200. Free-tier APIs (Finnhub 60/min,
   * SEC EDGAR self-rate-limited) won't cope well with much more per cycle.
   */
  limit?: number;
  /**
   * Pass `false` to skip discovery top-N (used by jobs that should ONLY
   * scan held + watchlist, e.g. pollPrices for intraday alerts on owned
   * stocks).
   */
  includeDiscoveryTop?: boolean;
}

export async function buildCatalystUniverse(opts: CatalystUniverseOptions = {}): Promise<string[]> {
  const limit = opts.limit ?? 200;
  const includeDiscoveryTop = opts.includeDiscoveryTop !== false;

  const [held, watchlist] = await Promise.all([
    prisma.position.findMany({
      where: { closedAt: null },
      select: { ticker: true },
    }),
    prisma.watchlist.findMany({ select: { ticker: true } }),
  ]);
  const set = new Set<string>();
  for (const p of held) set.add(p.ticker.toUpperCase());
  for (const w of watchlist) set.add(w.ticker.toUpperCase());

  if (includeDiscoveryTop) {
    try {
      const top = await latestTopN(limit, {
        excludeTickers: [...set],
        minScore: 0,
      });
      for (const r of top) set.add(r.ticker.toUpperCase());
    } catch (err) {
      log.warn({ err }, 'discovery candidates unavailable for catalyst universe');
    }
  }

  return Array.from(set).slice(0, limit);
}
