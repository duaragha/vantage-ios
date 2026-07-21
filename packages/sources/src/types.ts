/**
 * Shared adapter interface + normalized shapes.
 *
 * Each adapter implements SourceAdapter<T> and returns normalized data. Writing
 * to Postgres (Article/MarketEvent rows) is the ingestion pipeline's job (Phase 6),
 * not the adapter's.
 */

export interface SourceAdapter<T> {
  name: string;
  tier: 1 | 2 | 3;
  fetch(params: unknown): Promise<T[]>;
  rateLimit: { perMinute: number; perDay?: number };
}

/**
 * A news / social post normalized across sources. Maps 1:1 to the Article DB
 * model (minus id/embedding/clusterId which are assigned during ingestion).
 */
export interface NormalizedArticle {
  /** source identifier: 'finnhub' | 'edgar' | 'reddit' | 'stocktwits' | ... */
  source: string;
  /** base domain of the origin URL, e.g. 'reuters.com'. null for social sources without a domain. */
  domain: string | null;
  /** canonical URL; dedupe key at the DB layer. */
  url: string;
  headline: string;
  body: string | null;
  publishedAt: Date;
  /** tickers mentioned/filed-against. Best-effort extraction is the adapter's job when obvious (e.g. EDGAR filer, Finnhub tag, StockTwits symbol). */
  tickers: string[];
  /** Native social bull/bear tag when the source supplies one (StockTwits). null for untagged posts and non-social sources. */
  socialSentiment?: 'Bullish' | 'Bearish' | null;
}

/**
 * A structured market event normalized across sources. Maps to the MarketEvent
 * DB model.
 */
export interface NormalizedEvent {
  /** one of the EventKind values in the Prisma schema. Stringly-typed here so
   * this package doesn't pull in the Prisma client. */
  kind:
    | 'Earnings'
    | 'Filing8K'
    | 'BreakingNews'
    | 'IntradayMove'
    | 'SectorNews'
    | 'Macro'
    | 'SentimentSpike';
  ticker: string | null;
  occurredAt: Date;
  /** Arbitrary source-specific payload. Keep it flat & JSON-safe. */
  payload: Record<string, unknown>;
}

/** Latest quote snapshot. */
export interface NormalizedQuote {
  ticker: string;
  bid: number | null;
  ask: number | null;
  last: number | null;
  timestamp: Date;
  source: string;
}

/** OHLCV bar at some resolution. */
export interface NormalizedBar {
  ticker: string;
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** 'minute' | 'hour' | 'day' | ... */
  timeframe: string;
  source: string;
}
