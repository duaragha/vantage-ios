/**
 * yahoo-finance2 adapter for Canadian listings and last-resort US fallbacks.
 *
 * This is the primary free quote, history, profile, and fundamentals path for
 * `.TO` / `.NE` / `.V`; it is only a fallback for US quotes. Pinned to
 * yahoo-finance2@3.14.0 (package.json); if Yahoo breaks its unofficial endpoint,
 * callers degrade to their next stored/provider fallback instead of crashing.
 */

import YahooFinance from 'yahoo-finance2';
import type { NormalizedBar, NormalizedQuote } from './types.js';

const QUOTE_BATCH_SIZE = 50;

/**
 * Extended quote — includes currency + long name so the Phase 16 priceOracle
 * can stamp payload.currency and so ticker seeding can reuse Yahoo profile
 * fields for Canadian listings (Finnhub free tier rejects .TO / .NE / .V).
 */
export interface YFinanceQuote extends NormalizedQuote {
  currency: string | null;
  exchange: string | null;
  longName: string | null;
  shortName: string | null;
  /** `true` when the quote came back with a non-zero regularMarketPrice. */
  hasLast: boolean;
  dayOpen: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  dayVolume: number | null;
  prevClose: number | null;
}

export interface YFinanceProfile {
  symbol: string;
  longName: string | null;
  shortName: string | null;
  currency: string | null;
  exchange: string | null;
  sector: string | null;
  industry: string | null;
  marketCapUsd: number | null;
  /** Underlying reported market cap in the listing's own currency (Yahoo mixes). */
  marketCapRaw: number | null;
}

export function normalizeQuoteRecord(
  ticker: string,
  record: Record<string, unknown>,
): YFinanceQuote {
  const bid = typeof record.bid === 'number' ? record.bid : null;
  const ask = typeof record.ask === 'number' ? record.ask : null;
  const last = typeof record.regularMarketPrice === 'number' ? record.regularMarketPrice : null;
  const currency = typeof record.currency === 'string' ? record.currency : null;
  const exchange =
    typeof record.fullExchangeName === 'string'
      ? record.fullExchangeName
      : typeof record.exchange === 'string'
        ? record.exchange
        : null;
  const longName = typeof record.longName === 'string' ? record.longName : null;
  const shortName = typeof record.shortName === 'string' ? record.shortName : null;
  const finite = (key: string): number | null => {
    const value = record[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };
  const tsRaw: unknown = record.regularMarketTime;
  let timestamp = new Date();
  if (tsRaw instanceof Date) {
    timestamp = tsRaw;
  } else if (typeof tsRaw === 'number') {
    timestamp = new Date(tsRaw * 1000);
  } else if (typeof tsRaw === 'string') {
    const parsed = new Date(tsRaw);
    if (!Number.isNaN(parsed.getTime())) timestamp = parsed;
  }
  return {
    ticker: ticker.toUpperCase(),
    bid,
    ask,
    last,
    timestamp,
    source: 'yfinance',
    currency,
    exchange,
    longName,
    shortName,
    hasLast: typeof last === 'number' && last > 0,
    dayOpen: finite('regularMarketOpen'),
    dayHigh: finite('regularMarketDayHigh'),
    dayLow: finite('regularMarketDayLow'),
    dayVolume: finite('regularMarketVolume'),
    prevClose: finite('regularMarketPreviousClose'),
  };
}

/**
 * Fundamentals pulled from Yahoo's quoteSummary modules. Used by
 * pollFundamentals for Canadian listings where SEC EDGAR + Finnhub have no
 * coverage. Margins/growth fields are Yahoo decimals (0.31 = 31%); ratio
 * normalization to match the US (Finnhub) path is documented per-field below.
 *
 * `marketCapRaw` / `marketCap*` come back in the LISTING currency (CAD for
 * `.TO`/`.NE`/`.V`). We expose the raw value + its reported currency and leave
 * USD conversion to the caller (it owns the fx rate).
 */
export interface YFinanceFundamentals {
  ticker: string;
  /** Currency the marketCap + financials are reported in (e.g. 'CAD'). */
  currency: string | null;
  name: string | null;
  sector: string | null;
  industry: string | null;
  // valuation
  peTtm: number | null;
  pegTtm: number | null;
  psTtm: number | null;
  pbTtm: number | null;
  evToEbitda: number | null;
  // profitability (Yahoo returns margins as decimals, e.g. 0.31 = 31%)
  roeTtm: number | null;
  roaTtm: number | null;
  grossMarginTtm: number | null;
  operatingMarginTtm: number | null;
  netMarginTtm: number | null;
  // balance sheet
  debtToEquity: number | null;
  currentRatio: number | null;
  quickRatio: number | null;
  // dividends
  dividendYieldTtm: number | null;
  payoutRatio: number | null;
  // growth (Yahoo: earningsGrowth, revenueGrowth — decimals)
  revenueGrowthYoy: number | null;
  epsGrowthYoy: number | null;
  // size + risk — marketCapRaw is in `currency`, NOT USD.
  marketCapRaw: number | null;
  beta: number | null;
  sharesOutstanding: number | null;
  // quarterly snapshots for FundamentalsSnapshot (most recent first, last 4)
  quarters: Array<{
    periodEnd: Date;
    revenue: number | null;
    netIncome: number | null;
    epsDiluted: number | null;
    totalAssets: number | null;
    totalLiabilities: number | null;
    totalEquity: number | null;
    cash: number | null;
  }>;
}

export class YFinanceAdapter {
  readonly name = 'yfinance';
  readonly tier = 2 as const;
  readonly rateLimit = { perMinute: 60 };

  private readonly client: InstanceType<typeof YahooFinance>;

  constructor() {
    // Suppress the library's noisy one-time console notices.
    this.client = new YahooFinance({
      suppressNotices: ['yahooSurvey', 'ripHistorical'],
      validation: { logErrors: false, logOptionsErrors: false },
    });
  }

  /**
   * Latest quote. Returns null on any error (rate limit, network, or library
   * panic) so the poller can continue without this fallback.
   */
  async getQuote(ticker: string): Promise<YFinanceQuote | null> {
    const quotes = await this.getQuotes([ticker]);
    return quotes.get(ticker.trim().toUpperCase()) ?? null;
  }

  /** Batch latest quotes so Canadian scanner refreshes do not fan out per symbol. */
  async getQuotes(tickers: readonly string[]): Promise<Map<string, YFinanceQuote>> {
    const symbols = Array.from(
      new Set(tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean)),
    );
    const out = new Map<string, YFinanceQuote>();
    for (let offset = 0; offset < symbols.length; offset += QUOTE_BATCH_SIZE) {
      const batch = symbols.slice(offset, offset + QUOTE_BATCH_SIZE);
      try {
        const response = await this.client.quote(batch, {}, { validateResult: false });
        const rows = Array.isArray(response) ? response : [response];
        for (const value of rows) {
          if (!value || typeof value !== 'object') continue;
          const record = value as unknown as Record<string, unknown>;
          const symbol =
            typeof record.symbol === 'string'
              ? record.symbol.toUpperCase()
              : batch.length === 1
                ? batch[0]
                : null;
          if (!symbol) continue;
          out.set(symbol, normalizeQuoteRecord(symbol, record));
        }
      } catch (err) {
        console.warn(
          `[yfinance] getQuotes(${batch.length} symbols) failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return out;
  }

  /** Daily OHLCV history, primarily for Canadian listings Alpaca cannot cover. */
  async getDailyBars(ticker: string, start: Date, end: Date): Promise<NormalizedBar[]> {
    try {
      const raw = await this.client.chart(
        ticker,
        { period1: start, period2: end, interval: '1d', return: 'array' },
        { validateResult: false },
      );
      if (!raw || typeof raw !== 'object') return [];
      const quotes = (raw as { quotes?: unknown }).quotes;
      if (!Array.isArray(quotes)) return [];
      const out: NormalizedBar[] = [];
      for (const value of quotes) {
        if (!value || typeof value !== 'object') continue;
        const row = value as Record<string, unknown>;
        const timestamp = row['date'] instanceof Date ? row['date'] : new Date(String(row['date']));
        const open = finiteNumber(row['open']);
        const high = finiteNumber(row['high']);
        const low = finiteNumber(row['low']);
        const close = finiteNumber(row['close']);
        const volume = finiteNumber(row['volume']);
        if (
          Number.isNaN(timestamp.getTime()) ||
          open === null ||
          high === null ||
          low === null ||
          close === null
        ) {
          continue;
        }
        out.push({
          ticker: ticker.toUpperCase(),
          timestamp,
          open,
          high,
          low,
          close,
          volume: volume ?? 0,
          timeframe: 'day',
          source: 'yfinance',
        });
      }
      return out;
    } catch (err) {
      console.warn(
        `[yfinance] getDailyBars(${ticker}) failed:`,
        err instanceof Error ? err.message : err,
      );
      return [];
    }
  }

  /**
   * Fetch profile-style fields via quoteSummary — sector/industry/name/market
   * cap. Used by pollTickerUniverse to seed Canadian rows when Finnhub's
   * `/stock/profile2` would 403 on a `.TO` symbol.
   *
   * Yahoo reports market cap in the listing's own currency; callers who want
   * USD-normalized numbers should convert via the fx helper. `marketCapUsd`
   * here is a *rough* pass-through (USD when currency=USD, null otherwise) so
   * the caller can treat it as "already USD" without extra conversion.
   */
  async getProfile(ticker: string): Promise<YFinanceProfile | null> {
    try {
      const s = await this.client.quoteSummary(
        ticker,
        {
          modules: ['summaryProfile', 'price', 'assetProfile'],
        },
        { validateResult: false },
      );
      if (!s) return null;
      const record = s as Record<string, unknown>;
      const price = record['price'] as Record<string, unknown> | undefined;
      const asset = (record['assetProfile'] ?? record['summaryProfile']) as
        | Record<string, unknown>
        | undefined;

      const readString = (src: Record<string, unknown> | undefined, key: string): string | null => {
        const v = src?.[key];
        return typeof v === 'string' ? v : null;
      };
      const readNumber = (src: Record<string, unknown> | undefined, key: string): number | null => {
        const v = src?.[key];
        if (typeof v === 'number' && Number.isFinite(v)) return v;
        if (typeof v === 'object' && v !== null) {
          const raw = (v as { raw?: unknown }).raw;
          if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
        }
        return null;
      };

      const currency = readString(price, 'currency');
      const exchange = readString(price, 'exchangeName') ?? readString(price, 'exchange');
      const longName = readString(price, 'longName');
      const shortName = readString(price, 'shortName');
      const marketCapRaw = readNumber(price, 'marketCap');
      const sector = readString(asset, 'sector');
      const industry = readString(asset, 'industry');

      return {
        symbol: ticker.toUpperCase(),
        longName,
        shortName,
        currency,
        exchange,
        sector,
        industry,
        marketCapUsd: currency === 'USD' ? marketCapRaw : null,
        marketCapRaw,
      };
    } catch (err) {
      console.warn(
        `[yfinance] getProfile(${ticker}) failed:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  /**
   * Fundamentals via quoteSummary. Returns null on any error or when Yahoo has
   * no `financialData` block (ETFs/funds carry no company financials — that's
   * expected, not an error). Numeric fields tolerate both plain numbers and the
   * `{ raw }` wrapper older library builds emit.
   */
  async getFundamentals(ticker: string): Promise<YFinanceFundamentals | null> {
    try {
      // Ratios/margins/size come from quoteSummary. Yahoo deprecated the
      // *HistoryQuarterly submodules (empty since Nov 2024), so the quarterly
      // statements come from fundamentalsTimeSeries instead (see buildQuarters).
      const s = await this.client.quoteSummary(
        ticker,
        {
          modules: [
            'summaryDetail',
            'defaultKeyStatistics',
            'financialData',
            'assetProfile',
            'price',
          ],
        },
        { validateResult: false },
      );
      if (!s) return null;
      const record = s as Record<string, unknown>;
      const summaryDetail = record['summaryDetail'] as Record<string, unknown> | undefined;
      const keyStats = record['defaultKeyStatistics'] as Record<string, unknown> | undefined;
      const financialData = record['financialData'] as Record<string, unknown> | undefined;
      const assetProfile = record['assetProfile'] as Record<string, unknown> | undefined;
      const price = record['price'] as Record<string, unknown> | undefined;

      // No financialData block → not an operating company (ETF/fund). Bail so
      // the caller treats it as "no fundamentals" rather than a failure.
      if (!financialData) return null;

      const num = (src: Record<string, unknown> | undefined, key: string): number | null => {
        const v = src?.[key];
        if (typeof v === 'number' && Number.isFinite(v)) return v;
        if (typeof v === 'object' && v !== null) {
          const raw = (v as { raw?: unknown }).raw;
          if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
        }
        return null;
      };
      const str = (src: Record<string, unknown> | undefined, key: string): string | null => {
        const v = src?.[key];
        return typeof v === 'string' ? v : null;
      };

      // Yahoo reports debtToEquity as a percent (234 = 2.34x). Normalize to a
      // ratio so it matches the Finnhub `totalDebt/totalEquity` path.
      const debtToEquityPct = num(financialData, 'debtToEquity');
      const debtToEquity = debtToEquityPct !== null ? debtToEquityPct / 100 : null;

      const currency =
        str(financialData, 'financialCurrency') ??
        str(summaryDetail, 'currency') ??
        str(price, 'currency');

      return {
        ticker: ticker.toUpperCase(),
        currency,
        name: str(price, 'longName') ?? str(price, 'shortName'),
        sector: str(assetProfile, 'sector'),
        industry: str(assetProfile, 'industry'),
        peTtm: num(summaryDetail, 'trailingPE'),
        pegTtm: num(keyStats, 'pegRatio'),
        psTtm: num(summaryDetail, 'priceToSalesTrailing12Months'),
        pbTtm: num(keyStats, 'priceToBook'),
        evToEbitda: num(keyStats, 'enterpriseToEbitda'),
        roeTtm: num(financialData, 'returnOnEquity'),
        roaTtm: num(financialData, 'returnOnAssets'),
        grossMarginTtm: num(financialData, 'grossMargins'),
        operatingMarginTtm: num(financialData, 'operatingMargins'),
        netMarginTtm: num(financialData, 'profitMargins'),
        debtToEquity,
        currentRatio: num(financialData, 'currentRatio'),
        quickRatio: num(financialData, 'quickRatio'),
        dividendYieldTtm: num(summaryDetail, 'dividendYield'),
        payoutRatio: num(summaryDetail, 'payoutRatio'),
        revenueGrowthYoy: num(financialData, 'revenueGrowth'),
        epsGrowthYoy: num(financialData, 'earningsGrowth'),
        marketCapRaw: num(summaryDetail, 'marketCap') ?? num(price, 'marketCap'),
        beta: num(summaryDetail, 'beta') ?? num(keyStats, 'beta'),
        sharesOutstanding: num(keyStats, 'sharesOutstanding'),
        quarters: await this.buildQuarters(ticker),
      };
    } catch (err) {
      console.warn(
        `[yfinance] getFundamentals(${ticker}) failed:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  /**
   * Quarterly income + balance sheet via fundamentalsTimeSeries (module 'all').
   * Yahoo retired the quoteSummary *HistoryQuarterly submodules in Nov 2024;
   * this endpoint is the supported replacement. Returns the most recent 4
   * quarters, newest first. Never throws — returns [] on any failure so the
   * caller still gets the ratio fields from quoteSummary.
   */
  private async buildQuarters(ticker: string): Promise<YFinanceFundamentals['quarters']> {
    try {
      // ~2y window covers 4+ quarters with room for late filers.
      const period1 = new Date(Date.now() - 730 * 24 * 60 * 60 * 1000);
      const series = await this.client.fundamentalsTimeSeries(
        ticker,
        { period1, type: 'quarterly', module: 'all' },
        { validateResult: false },
      );
      const rows = Array.isArray(series) ? (series as Record<string, unknown>[]) : [];
      if (rows.length === 0) return [];

      const num = (src: Record<string, unknown>, key: string): number | null => {
        const v = src[key];
        if (typeof v === 'number' && Number.isFinite(v)) return v;
        if (typeof v === 'object' && v !== null) {
          const raw = (v as { raw?: unknown }).raw;
          if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
        }
        return null;
      };
      const toDate = (v: unknown): Date | null => {
        if (v instanceof Date && !Number.isNaN(v.getTime())) return v;
        if (typeof v === 'string') {
          const d = new Date(v);
          if (!Number.isNaN(d.getTime())) return d;
        }
        if (typeof v === 'number') return new Date(v * 1000);
        return null;
      };

      const out: YFinanceFundamentals['quarters'] = [];
      for (const r of rows) {
        const periodEnd = toDate(r['date']);
        if (!periodEnd) continue;
        out.push({
          periodEnd,
          revenue: num(r, 'totalRevenue'),
          netIncome: num(r, 'netIncome'),
          epsDiluted: num(r, 'dilutedEPS'),
          totalAssets: num(r, 'totalAssets'),
          // Yahoo's net-of-minority-interest line is the closest analogue to
          // the SEC `Liabilities` concept the US path stores.
          totalLiabilities: num(r, 'totalLiabilitiesNetMinorityInterest'),
          totalEquity: num(r, 'stockholdersEquity'),
          cash: num(r, 'cashAndCashEquivalents'),
        });
      }

      out.sort((a, b) => b.periodEnd.getTime() - a.periodEnd.getTime());
      return out.slice(0, 4);
    } catch (err) {
      console.warn(
        `[yfinance] buildQuarters(${ticker}) failed:`,
        err instanceof Error ? err.message : err,
      );
      return [];
    }
  }
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
