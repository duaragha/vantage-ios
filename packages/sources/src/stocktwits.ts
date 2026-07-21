/**
 * StockTwits adapter — legacy v2 streams API.
 *
 * StockTwits no longer grants new public API registrations. Callers must opt
 * in explicitly and this adapter circuit-breaks on 401/403 so one revoked
 * endpoint cannot emit a warning for every ticker every five minutes.
 * Rate limit: ~200/hr per IP. Keep conservative; we cap at 3/min (180/hr).
 *
 * Endpoint:
 *   GET https://api.stocktwits.com/api/2/streams/symbol/{TICKER}.json
 *
 * Always classified tier 3.
 */

import { RateLimiter } from './rate-limit.js';
import type { NormalizedArticle } from './types.js';

const BASE_URL = 'https://api.stocktwits.com/api/2';

export interface StocktwitsMessage {
  id: number;
  body: string;
  created_at: string;
  user: {
    id: number;
    username: string;
    name: string | null;
    followers: number;
  };
  symbols: Array<{ symbol: string; title: string }>;
  entities?: {
    sentiment: { basic: 'Bullish' | 'Bearish' } | null;
  };
  links?: Array<{ url: string }>;
  likes?: { total: number };
  reshares?: { reshared_count: number };
}

export interface StocktwitsStreamResponse {
  response: { status: number };
  symbol: { id: number; symbol: string; title: string };
  cursor: { more: boolean; since: number; max: number };
  messages: StocktwitsMessage[];
}

export interface StocktwitsAdapterOptions {
  rateLimiter?: RateLimiter;
  fetchImpl?: typeof fetch;
}

export interface StocktwitsArticle extends NormalizedArticle {
  socialSentiment: 'Bullish' | 'Bearish' | null;
}

export class StocktwitsAdapter {
  readonly name = 'stocktwits';
  readonly tier = 3 as const;
  readonly rateLimit = { perMinute: 3 };
  private readonly limiter: RateLimiter;
  private readonly fetchImpl: typeof fetch;
  private accessDisabled = false;

  constructor(opts: StocktwitsAdapterOptions = {}) {
    this.limiter = opts.rateLimiter ?? new RateLimiter({ perMinute: 3 });
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get isAccessDisabled(): boolean {
    return this.accessDisabled;
  }

  async getTickerStream(ticker: string): Promise<StocktwitsArticle[]> {
    const tk = ticker.toUpperCase();
    if (this.accessDisabled) return [];
    await this.limiter.acquire();
    const url = `${BASE_URL}/streams/symbol/${encodeURIComponent(tk)}.json`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers: { Accept: 'application/json' } });
    } catch (err) {
      console.warn(`[stocktwits] network error for ${tk}:`, err);
      return [];
    }
    if (res.status === 401 || res.status === 403) {
      this.accessDisabled = true;
      console.warn(
        `[stocktwits] API access rejected (${res.status}); disabling source until restart`,
      );
      return [];
    }
    if (res.status === 429 || res.status >= 500) {
      console.warn(`[stocktwits] soft failure ${res.status} for ${tk}`);
      return [];
    }
    if (res.status === 404) {
      return [];
    }
    if (!res.ok) {
      console.warn(`[stocktwits] unexpected ${res.status} for ${tk}`);
      return [];
    }
    const raw = (await res.json()) as StocktwitsStreamResponse;
    return raw.messages.map((m): StocktwitsArticle => {
      const sentiment = m.entities?.sentiment?.basic ?? null;
      const headline = m.body.slice(0, 140).replace(/\s+/g, ' ').trim();
      return {
        source: 'stocktwits',
        domain: 'stocktwits.com',
        url: `https://stocktwits.com/message/${m.id}`,
        headline: headline || `@${m.user.username} on $${tk}`,
        body: m.body,
        publishedAt: new Date(m.created_at),
        tickers: [tk, ...m.symbols.map((s) => s.symbol.toUpperCase()).filter((s) => s !== tk)],
        socialSentiment: sentiment,
      };
    });
  }
}
