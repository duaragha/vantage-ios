/**
 * Finnhub adapter — REST ONLY.
 *
 * Their news WebSocket is broken (per spec edge cases). REST poll only.
 *
 * Endpoints used:
 *   GET /company-news                    — company news by ticker + date range
 *   GET /calendar/earnings               — earnings calendar
 *   GET /stock/profile2                  — company profile
 *   GET /quote                           — latest quote
 *   GET /stock/recommendation            — analyst recs trend
 *   GET /stock/insider-transactions      — insider transactions
 *
 * Auth: ?token=<key> query param.
 * Rate limit: 60/min on the free tier.
 */

import { RateLimiter } from './rate-limit.js';
import type { NormalizedArticle } from './types.js';
import { classifyDomain } from './classify.js';

const BASE_URL = 'https://finnhub.io/api/v1';

/** Shape of a single item from /company-news. */
export interface FinnhubNewsItem {
  category: string;
  datetime: number; // unix seconds
  headline: string;
  id: number;
  image: string;
  related: string;
  source: string;
  summary: string;
  url: string;
}

export interface FinnhubEarningsItem {
  date: string; // YYYY-MM-DD
  epsActual: number | null;
  epsEstimate: number | null;
  hour: string; // 'bmo' | 'amc' | 'dmh' | ''
  quarter: number;
  revenueActual: number | null;
  revenueEstimate: number | null;
  symbol: string;
  year: number;
}

export interface FinnhubQuote {
  c: number; // current
  d: number | null; // change
  dp: number | null; // percent change
  h: number; // day high
  l: number; // day low
  o: number; // day open
  pc: number; // previous close
  t: number; // unix seconds
}

export interface FinnhubProfile {
  country?: string;
  currency?: string;
  exchange?: string;
  ipo?: string;
  marketCapitalization?: number;
  name?: string;
  phone?: string;
  shareOutstanding?: number;
  ticker?: string;
  weburl?: string;
  logo?: string;
  finnhubIndustry?: string;
}

export interface FinnhubRecommendation {
  buy: number;
  hold: number;
  period: string; // YYYY-MM-DD
  sell: number;
  strongBuy: number;
  strongSell: number;
  symbol: string;
}

export interface FinnhubInsiderTxn {
  name: string;
  share: number;
  change: number;
  filingDate: string;
  transactionDate: string;
  transactionCode: string;
  transactionPrice: number;
  symbol?: string;
}

/**
 * Normalized open-market insider purchase — Phase 17.
 *
 * Phase 17 adds an explicit purchase shape on top of the raw
 * `FinnhubInsiderTxn` so callers don't have to reapply Form-4 transaction
 * code semantics on every read. Purchases are transaction code 'P' (open
 * market buy); option exercises ('M'), grants, and sells are filtered out
 * by the normalizer before this leaves the adapter. Title is rarely
 * populated by Finnhub free tier — it's preserved when present and `null`
 * otherwise.
 */
export interface NormalizedInsiderPurchase {
  insiderName: string;
  insiderTitle: string | null;
  transactionDate: Date;
  transactionCode: 'P';
  /** Always positive — share count for the purchase. */
  shares: number;
  pricePerShare: number;
  /** shares × pricePerShare. */
  valueUsd: number;
  filingDate: Date;
}

export interface FinnhubBasicFinancials {
  symbol: string;
  metricType: string;
  metric: Record<string, number | undefined>;
}

/** One row from /stock/symbol. */
export interface FinnhubSymbolItem {
  currency?: string;
  description: string;
  displaySymbol: string;
  symbol: string;
  type: string; // "Common Stock" | "ETF" | "ADR" | …
  figi?: string;
  mic?: string;
  shareClassFIGI?: string;
  symbol2?: string;
  isin?: string | null;
}

/** One article from /news (market-wide feed). */
export interface FinnhubMarketNewsItem {
  category: string;
  datetime: number; // unix seconds
  headline: string;
  id: number;
  image: string;
  related: string; // comma-separated tickers (sometimes empty)
  source: string;
  summary: string;
  url: string;
}

/** Categories accepted by /news. "general" is the baseline; the others are finnhub-recognised sector feeds. */
export type FinnhubNewsCategory =
  | 'general'
  | 'technology'
  | 'forex'
  | 'crypto'
  | 'merger'
  | (string & Record<never, never>);

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface FinnhubAdapterOptions {
  apiKey?: string;
  rateLimiter?: RateLimiter;
  fetchImpl?: typeof fetch;
}

export class FinnhubAdapter {
  readonly name = 'finnhub';
  readonly rateLimit = { perMinute: 60 };
  private readonly apiKey: string;
  private readonly limiter: RateLimiter;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: FinnhubAdapterOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.FINNHUB_API_KEY;
    if (!apiKey) {
      throw new AuthError('FINNHUB_API_KEY is not set');
    }
    this.apiKey = apiKey;
    this.limiter = opts.rateLimiter ?? new RateLimiter({ perMinute: 60 });
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Build a fully-qualified URL with api key included. */
  private buildUrl(path: string, params: Record<string, string | number>): string {
    const url = new URL(`${BASE_URL}${path}`);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
    url.searchParams.set('token', this.apiKey);
    return url.toString();
  }

  /**
   * Low-level request. Returns `null` on soft failure (5xx, 429, network),
   * throws on auth failures (401/403) so callers know to check config.
   */
  private async request<T>(path: string, params: Record<string, string | number>): Promise<T | null> {
    await this.limiter.acquire();
    let res: Response;
    try {
      res = await this.fetchImpl(this.buildUrl(path, params), {
        headers: { Accept: 'application/json' },
      });
    } catch (err) {
      console.warn(`[finnhub] network error on ${path}:`, err);
      return null;
    }
    if (res.status === 401 || res.status === 403) {
      throw new AuthError(`finnhub auth failed (${res.status}) on ${path}`);
    }
    if (res.status === 429 || res.status >= 500) {
      console.warn(`[finnhub] soft failure ${res.status} on ${path}`);
      return null;
    }
    if (!res.ok) {
      console.warn(`[finnhub] unexpected ${res.status} on ${path}`);
      return null;
    }
    return (await res.json()) as T;
  }

  /** YYYY-MM-DD — Finnhub's expected date format. */
  private static formatDate(d: Date): string {
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  /**
   * GET /company-news?symbol=AAPL&from=YYYY-MM-DD&to=YYYY-MM-DD
   * Returns normalized articles (domain-classified tier stamped by caller via classify()).
   */
  async getCompanyNews(
    ticker: string,
    fromDate: Date,
    toDate: Date,
  ): Promise<NormalizedArticle[]> {
    const raw = await this.request<FinnhubNewsItem[]>('/company-news', {
      symbol: ticker.toUpperCase(),
      from: FinnhubAdapter.formatDate(fromDate),
      to: FinnhubAdapter.formatDate(toDate),
    });
    if (!raw) return [];
    return raw
      .filter((n) => n.url && n.headline)
      .map((n): NormalizedArticle => {
        const { domain } = classifyDomain(n.url);
        return {
          source: 'finnhub',
          domain,
          url: n.url,
          headline: n.headline,
          body: n.summary || null,
          publishedAt: new Date(n.datetime * 1000),
          tickers: [ticker.toUpperCase()],
        };
      });
  }

  /** Raw news passthrough for callers who need the original fields. */
  async getCompanyNewsRaw(
    ticker: string,
    fromDate: Date,
    toDate: Date,
  ): Promise<FinnhubNewsItem[]> {
    const raw = await this.request<FinnhubNewsItem[]>('/company-news', {
      symbol: ticker.toUpperCase(),
      from: FinnhubAdapter.formatDate(fromDate),
      to: FinnhubAdapter.formatDate(toDate),
    });
    return raw ?? [];
  }

  /** GET /calendar/earnings?from=&to= — returns an `earningsCalendar` array. */
  async getEarningsCalendar(fromDate: Date, toDate: Date): Promise<FinnhubEarningsItem[]> {
    const raw = await this.request<{ earningsCalendar?: FinnhubEarningsItem[] }>(
      '/calendar/earnings',
      {
        from: FinnhubAdapter.formatDate(fromDate),
        to: FinnhubAdapter.formatDate(toDate),
      },
    );
    return raw?.earningsCalendar ?? [];
  }

  async getCompanyProfile(ticker: string): Promise<FinnhubProfile | null> {
    const raw = await this.request<FinnhubProfile>('/stock/profile2', {
      symbol: ticker.toUpperCase(),
    });
    if (!raw || Object.keys(raw).length === 0) return null;
    return raw;
  }

  async getQuote(ticker: string): Promise<FinnhubQuote | null> {
    const raw = await this.request<FinnhubQuote>('/quote', { symbol: ticker.toUpperCase() });
    // Finnhub returns zeros for unknown symbols; treat t===0 as not found.
    if (!raw || raw.t === 0) return null;
    return raw;
  }

  async getRecommendations(ticker: string): Promise<FinnhubRecommendation[]> {
    const raw = await this.request<FinnhubRecommendation[]>('/stock/recommendation', {
      symbol: ticker.toUpperCase(),
    });
    return raw ?? [];
  }

  async getInsiderTransactions(ticker: string): Promise<FinnhubInsiderTxn[]> {
    const raw = await this.request<{ data?: FinnhubInsiderTxn[] }>(
      '/stock/insider-transactions',
      { symbol: ticker.toUpperCase() },
    );
    return raw?.data ?? [];
  }

  /**
   * Phase 17 — normalized open-market purchases for `ticker`.
   *
   * Filters Finnhub's `/stock/insider-transactions` to transaction code
   * 'P' (open-market buy) and drops anything else: option exercises ('M'),
   * grants, sells ('S'), gifts ('G'), tax-withholding sells ('F'), etc.
   * Returns normalized `NormalizedInsiderPurchase` rows (typed dates, signed
   * USD value) ready for the InsiderTransaction CRUD helper.
   *
   * Sign convention from Finnhub: `change` is signed (positive on a buy,
   * negative on a sell); `share` is unsigned. We use `change` first when it
   * has the right sign for a 'P' code, falling back to absolute(`share`).
   *
   * Per spec edge case: filings are sometimes pre-split-adjusted while the
   * `transactionPrice` is post-split. Callers who care can reject txns where
   * `pricePerShare` is more than 20% off the contemporaneous DailyBar close —
   * that filter lives in the cluster detector, not here, so this stays a
   * thin normalizer.
   */
  async getInsiderPurchases(
    ticker: string,
  ): Promise<NormalizedInsiderPurchase[]> {
    const raw = await this.getInsiderTransactions(ticker);
    const out: NormalizedInsiderPurchase[] = [];
    for (const t of raw) {
      if (t.transactionCode !== 'P') continue;
      const txnDate = t.transactionDate ? new Date(t.transactionDate) : null;
      const filingDate = t.filingDate ? new Date(t.filingDate) : null;
      if (!txnDate || Number.isNaN(txnDate.getTime())) continue;
      if (!filingDate || Number.isNaN(filingDate.getTime())) continue;
      const price = Number(t.transactionPrice);
      if (!Number.isFinite(price) || price <= 0) continue;
      const change = Number(t.change);
      const shareRaw = Number(t.share);
      // Pick a positive share count — `change` is the authoritative signed
      // delta when it parses; otherwise fall back to |share|.
      let shares: number;
      if (Number.isFinite(change) && change > 0) shares = change;
      else if (Number.isFinite(shareRaw) && shareRaw > 0) shares = shareRaw;
      else continue;
      const valueUsd = shares * price;
      if (!Number.isFinite(valueUsd) || valueUsd <= 0) continue;
      const insiderName = (t.name ?? '').trim();
      if (!insiderName) continue;
      out.push({
        insiderName,
        insiderTitle: null, // Finnhub free tier rarely populates this.
        transactionDate: txnDate,
        transactionCode: 'P',
        shares,
        pricePerShare: price,
        valueUsd,
        filingDate,
      });
    }
    return out;
  }

  /**
   * Phase 17 — recommendation-trends shortcut returning the latest two
   * monthly periods (current vs prior). Mirrors `getRecommendations`
   * (which returns the full series) but trims down to the rows the upgrade
   * detector needs. Returned array is sorted descending by `period`.
   */
  async getRecommendationTrends(
    ticker: string,
  ): Promise<FinnhubRecommendation[]> {
    const raw = await this.getRecommendations(ticker);
    if (raw.length === 0) return [];
    return [...raw].sort((a, b) =>
      a.period < b.period ? 1 : a.period > b.period ? -1 : 0,
    );
  }

  async getBasicFinancials(ticker: string): Promise<FinnhubBasicFinancials | null> {
    const raw = await this.request<{
      symbol?: string;
      metricType?: string;
      metric?: Record<string, number | undefined>;
    }>('/stock/metric', {
      symbol: ticker.toUpperCase(),
      metric: 'all',
    });
    if (!raw || !raw.metric || Object.keys(raw.metric).length === 0) return null;
    return {
      symbol: raw.symbol ?? ticker.toUpperCase(),
      metricType: raw.metricType ?? 'all',
      metric: raw.metric,
    };
  }

  /**
   * GET /stock/symbol?exchange=<code>
   *
   * Returns the full symbol list for an exchange. Callers should filter to
   * `type === 'Common Stock'` (see the pollTickerUniverse job) to drop ETFs,
   * warrants, ADR duplicates, etc.
   *
   * Free-tier coverage (verified live against the app's FINNHUB_API_KEY on
   * 2026-04-21):
   *   - US   : works
   *   - TO   : 403 ("You don't have access to this resource.")
   *   - NE   : 403
   *   - V    : 403
   *
   * This is an adapter-level signature change only — if the key is ever
   * upgraded to a paid tier, TO/NE/V will start returning data without any
   * caller-side changes. For now, pollTickerUniverse seeds Canadian rows from
   * a curated list and enriches via the yfinance adapter.
   */
  async listSymbols(
    exchange: 'US' | 'TO' | 'NE' | 'V' | string = 'US',
  ): Promise<FinnhubSymbolItem[]> {
    const raw = await this.request<FinnhubSymbolItem[]>('/stock/symbol', {
      exchange,
    });
    return raw ?? [];
  }

  /**
   * GET /news?category=<category>
   *
   * The market-wide news endpoint — returns articles across the whole
   * category, not scoped to a ticker (unlike /company-news). Free tier
   * categories per Finnhub docs: 'general' | 'forex' | 'crypto' | 'merger'.
   * We pass through any string so sector-style categories (e.g. 'technology')
   * still work if the feed exists; callers should fall back to 'general' when
   * a category returns an empty array.
   */
  async getGeneralNews(
    category: FinnhubNewsCategory = 'general',
  ): Promise<FinnhubMarketNewsItem[]> {
    const raw = await this.request<FinnhubMarketNewsItem[]>('/news', {
      category: String(category),
    });
    return raw ?? [];
  }
}
