/**
 * DB-backed loaders that build AccountSummary[] + StockProfile inputs for the
 * placement engine. Used by the catalyst engine and the rotation scorer — the
 * web app has its own copy in accounts/actions.ts (web cannot import from core
 * to avoid pulling the prisma client through Next's edge bundling).
 *
 * Corporate accounts are excluded — the placement engine's AccountType enum
 * doesn't model them, so they can never be selected as bestAccountId. Returning
 * an AccountSummary with type='Corporate' would fail the engine's type
 * narrowing.
 */

import { prisma, getLatestBarsForTickers } from '@vantage/db';
import { getUsdCadRate } from '../fx.js';
import { auditPortfolio } from '../portfolio/valuation.js';
import { percentagePointsToRatio } from '../units.js';
import { exchangeFromSymbol, isCaExchange } from '@vantage/sources';
import type { AccountSummary, AccountType, StockProfile } from './placement.js';

/**
 * Read all accounts and roll up `currentValueCad` per the dashboard's rule:
 * latest DailyBar close × shares, falling back to avgCost when no bar exists.
 * Each position is converted from its listing currency via FRED DEXCAUS. The
 * account denomination is metadata only; a CAD account can hold USD listings.
 *
 * Archived accounts are included so callers can filter them by reading
 * `.archived` — the placement engine itself skips archived rows.
 */
export async function loadAccountSummaries(): Promise<AccountSummary[]> {
  const accounts = await prisma.account.findMany({
    include: {
      positions: {
        select: {
          ticker: true,
          shares: true,
          avgCost: true,
          currency: true,
          closedAt: true,
        },
      },
    },
    orderBy: { id: 'asc' },
  });

  const allTickers = Array.from(
    new Set(
      accounts.flatMap((a) =>
        a.positions.filter((p) => p.closedAt === null).map((p) => p.ticker.toUpperCase()),
      ),
    ),
  );

  const [bars, usdCadRate] = await Promise.all([
    allTickers.length > 0 ? getLatestBarsForTickers(allTickers) : Promise.resolve(new Map()),
    getUsdCadRate(),
  ]);

  const out: AccountSummary[] = [];
  for (const a of accounts) {
    // Corporate is in the schema enum but not the placement engine — drop it.
    if ((a.type as string) === 'Corporate') continue;

    const open = a.positions.filter((p) => p.closedAt === null);
    const prices = Object.fromEntries(
      open.flatMap((p) => {
        const bar = bars.get(p.ticker.toUpperCase());
        const close = bar ? Number(bar.close) : Number(p.avgCost);
        return Number.isFinite(close) && close > 0 ? [[p.ticker.toUpperCase(), close]] : [];
      }),
    );
    const audit = auditPortfolio({ positions: open, prices, usdCadRate });
    const currency: 'CAD' | 'USD' = a.currency === 'USD' ? 'USD' : 'CAD';

    out.push({
      id: a.id,
      type: a.type as AccountType,
      currency,
      contributionRoomCad: a.contributionRoomCad !== null ? Number(a.contributionRoomCad) : null,
      currentValueCad: Math.round(audit.totalValueCad * 100) / 100,
      archived: a.archivedAt !== null,
    });
  }
  return out;
}

/**
 * Build a StockProfile for `ticker` from TickerUniverse + TickerMetrics. Returns
 * null when no TickerMetrics row exists — callers should treat that as "skip
 * placement guidance" rather than degrading silently to a default profile.
 */
export async function loadStockProfile(ticker: string): Promise<StockProfile | null> {
  const symbol = ticker.toUpperCase();
  const [universe, metrics] = await Promise.all([
    prisma.tickerUniverse.findUnique({
      where: { symbol },
      select: { exchange: true, isLottery: true, marketCapUsd: true },
    }),
    prisma.tickerMetrics.findUnique({
      where: { ticker: symbol },
      select: {
        dividendYieldTtm: true,
        epsGrowth5y: true,
        revenueGrowth5y: true,
        beta: true,
        marketCapUsd: true,
      },
    }),
  ]);

  if (!metrics) return null;

  const suffixExchange = exchangeFromSymbol(symbol);
  const exchange = suffixExchange !== 'US' ? suffixExchange : (universe?.exchange ?? 'US');
  const listingCountry: 'US' | 'CA' = isCaExchange(exchange) ? 'CA' : 'US';

  // Prefer epsGrowth5y; fall back to revenueGrowth5y.
  const growth5y = percentagePointsToRatio(metrics.epsGrowth5y ?? metrics.revenueGrowth5y);

  const marketCapUsd = metrics.marketCapUsd
    ? Number(metrics.marketCapUsd)
    : universe?.marketCapUsd
      ? Number(universe.marketCapUsd)
      : null;

  return {
    ticker: symbol,
    listingCountry,
    dividendYieldTtm: percentagePointsToRatio(metrics.dividendYieldTtm),
    growth5y,
    beta: metrics.beta ?? null,
    isSpeculative: universe?.isLottery ?? false,
    marketCapUsd,
  };
}
