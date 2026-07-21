/**
 * Seed the TickerUniverse with hand-curated Canadian + US ETFs.
 *
 * The nightly Tiingo/Twelve Data refresh biases the universe to common
 * equities — many TSX ETFs and a handful of US income ETFs never land in
 * those feeds, which breaks downstream lookups for tickers held in real
 * portfolios (QQQI, CASH.TO, XEQT.TO, ...). This is a one-shot seed run
 * after deploys to backfill those rows with the right category tag so
 * goals + rebalance can find them.
 *
 * For existing rows we correct category/exchange/currency because those fields
 * drive goal/discovery filters. We leave scraped market cap alone and only
 * backfill name/sector when they are empty.
 */

import type { FastifyBaseLogger } from 'fastify';
import { prisma, type SecurityCategory } from '@vantage/db';

const PROGRESS_EVERY = 10;

interface EtfSeedEntry {
  symbol: string;
  name: string;
  exchange: string;
  currency: 'USD' | 'CAD';
  sector: string | null;
  category: SecurityCategory;
  marketCapUsd: number | null;
}

// Hand-curated list — kept in sync with packages/core/src/goals/securityPool.ts
// for the curated-pool tickers, plus high-volume US/CA ETFs that show up in
// real portfolios. Re-review annually.
export const ETF_SEED: readonly EtfSeedEntry[] = Object.freeze([
  // CashEquivalent — TSX
  {
    symbol: 'CASH.TO',
    name: 'Global X High Interest Savings ETF',
    exchange: 'TSX',
    currency: 'CAD',
    sector: 'ETF',
    category: 'CashEquivalent',
    marketCapUsd: null,
  },
  {
    symbol: 'CBIL.TO',
    name: 'Global X 0-3 Month T-Bill ETF',
    exchange: 'TSX',
    currency: 'CAD',
    sector: 'ETF',
    category: 'CashEquivalent',
    marketCapUsd: null,
  },
  {
    symbol: 'PSA.TO',
    name: 'Purpose High Interest Savings ETF',
    exchange: 'TSX',
    currency: 'CAD',
    sector: 'ETF',
    category: 'CashEquivalent',
    marketCapUsd: null,
  },
  {
    symbol: 'ZMMK.TO',
    name: 'BMO Money Market Fund ETF',
    exchange: 'TSX',
    currency: 'CAD',
    sector: 'ETF',
    category: 'CashEquivalent',
    marketCapUsd: null,
  },

  // ShortTermBond — TSX
  {
    symbol: 'XSB.TO',
    name: 'iShares Core Canadian Short Term Bond Index ETF',
    exchange: 'TSX',
    currency: 'CAD',
    sector: 'ETF',
    category: 'ShortTermBond',
    marketCapUsd: null,
  },
  {
    symbol: 'VSB.TO',
    name: 'Vanguard Canadian Short-Term Bond Index ETF',
    exchange: 'TSX',
    currency: 'CAD',
    sector: 'ETF',
    category: 'ShortTermBond',
    marketCapUsd: null,
  },

  // DividendCanadian — TSX
  {
    symbol: 'VDY.TO',
    name: 'Vanguard FTSE Canadian High Dividend Yield Index ETF',
    exchange: 'TSX',
    currency: 'CAD',
    sector: 'ETF',
    category: 'DividendCanadian',
    marketCapUsd: null,
  },
  {
    symbol: 'ZDV.TO',
    name: 'BMO Canadian Dividend ETF',
    exchange: 'TSX',
    currency: 'CAD',
    sector: 'ETF',
    category: 'DividendCanadian',
    marketCapUsd: null,
  },
  {
    symbol: 'XEI.TO',
    name: 'iShares S&P/TSX Composite High Dividend Index ETF',
    exchange: 'TSX',
    currency: 'CAD',
    sector: 'ETF',
    category: 'DividendCanadian',
    marketCapUsd: null,
  },

  // DividendUS
  {
    symbol: 'SCHD',
    name: 'Schwab US Dividend Equity ETF',
    exchange: 'NYSE Arca',
    currency: 'USD',
    sector: 'ETF',
    category: 'DividendUS',
    marketCapUsd: null,
  },
  {
    symbol: 'VYM',
    name: 'Vanguard High Dividend Yield ETF',
    exchange: 'NYSE Arca',
    currency: 'USD',
    sector: 'ETF',
    category: 'DividendUS',
    marketCapUsd: null,
  },
  {
    symbol: 'QQQI',
    name: 'NEOS Nasdaq-100 High Income ETF',
    exchange: 'NYSE Arca',
    currency: 'USD',
    sector: 'ETF',
    category: 'CoveredCall',
    marketCapUsd: null,
  },
  {
    symbol: 'SPYI',
    name: 'NEOS S&P 500 High Income ETF',
    exchange: 'NYSE Arca',
    currency: 'USD',
    sector: 'ETF',
    category: 'CoveredCall',
    marketCapUsd: null,
  },
  {
    symbol: 'JEPI',
    name: 'JPMorgan Equity Premium Income ETF',
    exchange: 'NYSE Arca',
    currency: 'USD',
    sector: 'ETF',
    category: 'CoveredCall',
    marketCapUsd: null,
  },
  {
    symbol: 'JEPQ',
    name: 'JPMorgan Nasdaq Equity Premium Income ETF',
    exchange: 'NASDAQ',
    currency: 'USD',
    sector: 'ETF',
    category: 'CoveredCall',
    marketCapUsd: null,
  },

  // CoveredCall — TSX
  {
    symbol: 'ZWB.TO',
    name: 'BMO Covered Call Canadian Banks ETF',
    exchange: 'TSX',
    currency: 'CAD',
    sector: 'ETF',
    category: 'CoveredCall',
    marketCapUsd: null,
  },
  {
    symbol: 'ZWU.TO',
    name: 'BMO Covered Call Utilities ETF',
    exchange: 'TSX',
    currency: 'CAD',
    sector: 'ETF',
    category: 'CoveredCall',
    marketCapUsd: null,
  },
  {
    symbol: 'ZWC.TO',
    name: 'BMO Canadian High Dividend Covered Call ETF',
    exchange: 'TSX',
    currency: 'CAD',
    sector: 'ETF',
    category: 'CoveredCall',
    marketCapUsd: null,
  },
  {
    symbol: 'HMAX.TO',
    name: 'Hamilton Canadian Financials Yield Maximizer ETF',
    exchange: 'TSX',
    currency: 'CAD',
    sector: 'ETF',
    category: 'CoveredCall',
    marketCapUsd: null,
  },
  {
    symbol: 'HDIV.TO',
    name: 'Hamilton Enhanced Multi-Sector Covered Call ETF',
    exchange: 'TSX',
    currency: 'CAD',
    sector: 'ETF',
    category: 'CoveredCall',
    marketCapUsd: null,
  },

  // REIT / BDC / high-yield credit — US monthly income
  {
    symbol: 'O',
    name: 'Realty Income Corp',
    exchange: 'NYSE',
    currency: 'USD',
    sector: 'REIT',
    category: 'REIT',
    marketCapUsd: null,
  },
  {
    symbol: 'MAIN',
    name: 'Main Street Capital',
    exchange: 'NYSE',
    currency: 'USD',
    sector: 'Financial Services',
    category: 'CoveredCall',
    marketCapUsd: null,
  },
  {
    symbol: 'HYG',
    name: 'iShares iBoxx High Yield Corporate Bond ETF',
    exchange: 'NYSE Arca',
    currency: 'USD',
    sector: 'ETF',
    category: 'CoveredCall',
    marketCapUsd: null,
  },
  {
    symbol: 'JNK',
    name: 'SPDR Bloomberg High Yield Bond ETF',
    exchange: 'NYSE Arca',
    currency: 'USD',
    sector: 'ETF',
    category: 'CoveredCall',
    marketCapUsd: null,
  },

  // AllEquity — TSX
  {
    symbol: 'XEQT.TO',
    name: 'iShares Core Equity ETF Portfolio',
    exchange: 'TSX',
    currency: 'CAD',
    sector: 'ETF',
    category: 'AllEquity',
    marketCapUsd: null,
  },
  {
    symbol: 'VEQT.TO',
    name: 'Vanguard All-Equity ETF Portfolio',
    exchange: 'TSX',
    currency: 'CAD',
    sector: 'ETF',
    category: 'AllEquity',
    marketCapUsd: null,
  },

  // EquityUS — TSX-listed S&P500 wrappers
  {
    symbol: 'VFV.TO',
    name: 'Vanguard S&P 500 Index ETF',
    exchange: 'TSX',
    currency: 'CAD',
    sector: 'ETF',
    category: 'EquityUS',
    marketCapUsd: null,
  },
  {
    symbol: 'ZSP.TO',
    name: 'BMO S&P 500 Index ETF',
    exchange: 'TSX',
    currency: 'CAD',
    sector: 'ETF',
    category: 'EquityUS',
    marketCapUsd: null,
  },
  {
    symbol: 'HXT.TO',
    name: 'Global X S&P/TSX 60 Index Corporate Class ETF',
    exchange: 'TSX',
    currency: 'CAD',
    sector: 'ETF',
    category: 'EquityCanadian',
    marketCapUsd: null,
  },

  // EquityUS — US-listed broad market
  {
    symbol: 'VTI',
    name: 'Vanguard Total Stock Market ETF',
    exchange: 'NYSE Arca',
    currency: 'USD',
    sector: 'ETF',
    category: 'EquityUS',
    marketCapUsd: null,
  },
  {
    symbol: 'QQQ',
    name: 'Invesco QQQ Trust',
    exchange: 'NASDAQ',
    currency: 'USD',
    sector: 'ETF',
    category: 'EquityUS',
    marketCapUsd: null,
  },
  {
    symbol: 'SPY',
    name: 'SPDR S&P 500 ETF Trust',
    exchange: 'NYSE Arca',
    currency: 'USD',
    sector: 'ETF',
    category: 'EquityUS',
    marketCapUsd: null,
  },
  {
    symbol: 'VOO',
    name: 'Vanguard S&P 500 ETF',
    exchange: 'NYSE Arca',
    currency: 'USD',
    sector: 'ETF',
    category: 'EquityUS',
    marketCapUsd: null,
  },
  {
    symbol: 'IVV',
    name: 'iShares Core S&P 500 ETF',
    exchange: 'NYSE Arca',
    currency: 'USD',
    sector: 'ETF',
    category: 'EquityUS',
    marketCapUsd: null,
  },
  {
    symbol: 'SCHB',
    name: 'Schwab US Broad Market ETF',
    exchange: 'NYSE Arca',
    currency: 'USD',
    sector: 'ETF',
    category: 'EquityUS',
    marketCapUsd: null,
  },

  // EquityCanadian — TSX
  {
    symbol: 'XIU.TO',
    name: 'iShares S&P/TSX 60 Index ETF',
    exchange: 'TSX',
    currency: 'CAD',
    sector: 'ETF',
    category: 'EquityCanadian',
    marketCapUsd: null,
  },
  {
    symbol: 'ZCN.TO',
    name: 'BMO S&P/TSX Capped Composite Index ETF',
    exchange: 'TSX',
    currency: 'CAD',
    sector: 'ETF',
    category: 'EquityCanadian',
    marketCapUsd: null,
  },
  {
    symbol: 'VCN.TO',
    name: 'Vanguard FTSE Canada All Cap Index ETF',
    exchange: 'TSX',
    currency: 'CAD',
    sector: 'ETF',
    category: 'EquityCanadian',
    marketCapUsd: null,
  },

  // Balanced / Growth — TSX
  {
    symbol: 'XBAL.TO',
    name: 'iShares Core Balanced ETF Portfolio',
    exchange: 'TSX',
    currency: 'CAD',
    sector: 'ETF',
    category: 'Balanced',
    marketCapUsd: null,
  },
  {
    symbol: 'XGRO.TO',
    name: 'iShares Core Growth ETF Portfolio',
    exchange: 'TSX',
    currency: 'CAD',
    sector: 'ETF',
    category: 'Growth',
    marketCapUsd: null,
  },

  // IntermediateBond — TSX
  {
    symbol: 'ZAG.TO',
    name: 'BMO Aggregate Bond Index ETF',
    exchange: 'TSX',
    currency: 'CAD',
    sector: 'ETF',
    category: 'IntermediateBond',
    marketCapUsd: null,
  },
  {
    symbol: 'XBB.TO',
    name: 'iShares Core Canadian Universe Bond Index ETF',
    exchange: 'TSX',
    currency: 'CAD',
    sector: 'ETF',
    category: 'IntermediateBond',
    marketCapUsd: null,
  },

  // EquityInternational
  {
    symbol: 'XAW.TO',
    name: 'iShares Core MSCI All Country World ex Canada Index ETF',
    exchange: 'TSX',
    currency: 'CAD',
    sector: 'ETF',
    category: 'EquityInternational',
    marketCapUsd: null,
  },
  {
    symbol: 'VXUS',
    name: 'Vanguard Total International Stock ETF',
    exchange: 'NASDAQ',
    currency: 'USD',
    sector: 'ETF',
    category: 'EquityInternational',
    marketCapUsd: null,
  },
  {
    symbol: 'IXUS',
    name: 'iShares Core MSCI Total International Stock ETF',
    exchange: 'NASDAQ',
    currency: 'USD',
    sector: 'ETF',
    category: 'EquityInternational',
    marketCapUsd: null,
  },
]);

export interface SeedEtfUniverseResult {
  considered: number;
  inserted: number;
  updated: number;
  failedTickers: string[];
}

export async function seedEtfUniverse(
  log: FastifyBaseLogger | Console = console,
): Promise<SeedEtfUniverseResult> {
  const failedTickers: string[] = [];
  let inserted = 0;
  let updated = 0;
  let done = 0;

  for (const entry of ETF_SEED) {
    done++;
    const symbol = entry.symbol.toUpperCase();

    try {
      // findUnique first so we can classify insert vs update for the summary
      // (upsert alone doesn't tell us which path it took).
      const existing = await prisma.tickerUniverse.findUnique({
        where: { symbol },
        select: { id: true, name: true, sector: true },
      });

      if (existing) {
        // Correct fields used by app filters; preserve scraped marketCap and
        // populated profile fields where they already exist.
        await prisma.tickerUniverse.update({
          where: { symbol },
          data: {
            category: entry.category,
            exchange: entry.exchange,
            currency: entry.currency,
            ...(existing.name.trim() ? {} : { name: entry.name }),
            ...(existing.sector ? {} : { sector: entry.sector }),
          },
        });
        updated++;
      } else {
        await prisma.tickerUniverse.create({
          data: {
            symbol,
            name: entry.name,
            exchange: entry.exchange,
            currency: entry.currency,
            sector: entry.sector,
            category: entry.category,
            marketCapUsd: entry.marketCapUsd,
          },
        });
        inserted++;
      }
    } catch (err) {
      failedTickers.push(symbol);
      log.warn?.(
        { symbol, err: err instanceof Error ? err.message : err },
        'seedEtfUniverse: upsert failed',
      );
    }

    if (done % PROGRESS_EVERY === 0) {
      log.info?.({ done, total: ETF_SEED.length, inserted, updated }, 'seedEtfUniverse: progress');
    }
  }

  const result: SeedEtfUniverseResult = {
    considered: ETF_SEED.length,
    inserted,
    updated,
    failedTickers,
  };
  log.info?.(result, 'seedEtfUniverse: done');
  return result;
}
