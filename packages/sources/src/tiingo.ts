/**
 * Tiingo adapter — EOD daily prices + metadata + supported-tickers bulk dump.
 *
 * Base URL:     https://api.tiingo.com
 * Auth header:  Authorization: Token <key>
 * Rate limit:   1000/hr and 500 unique symbols/hr — we cap at ~16/min to stay
 *               well under both limits with steady-state polling.
 *
 * downloadSupportedTickers() hits a static zip on apimedia.tiingo.com that
 * needs no auth and no rate limit — it's a once-per-day refresh of the whole
 * US universe (~127k rows). Used by the ticker-universe seed job.
 */

import JSZip from 'jszip';
import { RateLimiter } from './rate-limit.js';
import type { NormalizedBar } from './types.js';

const BASE_URL = 'https://api.tiingo.com';
const SUPPORTED_TICKERS_URL = 'https://apimedia.tiingo.com/docs/tiingo/daily/supported_tickers.zip';

export class TiingoAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TiingoAuthError';
  }
}

export interface TiingoDailyPrice {
  date: string; // ISO
  close: number;
  high: number;
  low: number;
  open: number;
  volume: number;
  adjClose: number;
  adjHigh: number;
  adjLow: number;
  adjOpen: number;
  adjVolume: number;
  divCash: number;
  splitFactor: number;
}

export interface TiingoMeta {
  ticker: string;
  name?: string;
  description?: string;
  exchangeCode?: string;
  startDate?: string;
  endDate?: string;
}

/**
 * A single row from the supported_tickers.zip CSV.
 *
 * CSV header order (verified 2026-04-21):
 *   ticker,exchange,assetType,priceCurrency,startDate,endDate
 *
 * The file is a full snapshot of every symbol Tiingo has ever priced — ~127k
 * rows including delisted names. Tiingo currently defines endDate as the
 * latest available price date, while older snapshots left it blank for active
 * names. The adapter supports both shapes.
 */
export interface TiingoSupportedTicker {
  ticker: string;
  exchange: string;
  assetType: string;
  priceCurrency: string;
  startDate: string;
  endDate: string;
}

export interface DownloadSupportedTickersOptions {
  /**
   * If true, filter to active common-stock rows:
   *   - `assetType === 'Stock'`
   *   - blank endDate (legacy feed) or recent endDate relative to this file's
   *     newest stock row (current feed)
   *
   * Default true. Set false to get the full raw CSV including ETFs, mutual
   * funds, and delisted names.
   */
  activeCommonStockOnly?: boolean;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
}

export interface TiingoAdapterOptions {
  apiKey?: string;
  rateLimiter?: RateLimiter;
  fetchImpl?: typeof fetch;
}

export class TiingoAdapter {
  readonly name = 'tiingo';
  readonly rateLimit = { perMinute: 16, perDay: 1000 * 24 };
  private readonly apiKey: string;
  private readonly limiter: RateLimiter;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: TiingoAdapterOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.TIINGO_API_KEY;
    if (!apiKey) {
      throw new TiingoAuthError('TIINGO_API_KEY is not set');
    }
    this.apiKey = apiKey;
    // 1000/hr = ~16.6/min. Cap at 16 to leave headroom.
    this.limiter = opts.rateLimiter ?? new RateLimiter({ perMinute: 16 });
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Token ${this.apiKey}`,
      Accept: 'application/json',
    };
  }

  private async get<T>(path: string, params?: Record<string, string>): Promise<T | null> {
    await this.limiter.acquire();
    const url = new URL(`${BASE_URL}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    }
    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), { headers: this.headers() });
    } catch (err) {
      console.warn(`[tiingo] network error on ${path}:`, err);
      return null;
    }
    if (res.status === 401 || res.status === 403) {
      throw new TiingoAuthError(`tiingo auth failed (${res.status}) on ${path}`);
    }
    if (res.status === 404) {
      return null;
    }
    if (res.status === 429 || res.status >= 500) {
      console.warn(`[tiingo] soft failure ${res.status} on ${path}`);
      return null;
    }
    if (!res.ok) {
      console.warn(`[tiingo] unexpected ${res.status} on ${path}`);
      return null;
    }
    return (await res.json()) as T;
  }

  private static formatDate(d: Date): string {
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  /** Daily EOD bars for a ticker within [startDate, endDate]. */
  async getDailyPrices(ticker: string, startDate: Date, endDate: Date): Promise<NormalizedBar[]> {
    const raw = await this.get<TiingoDailyPrice[]>(
      `/tiingo/daily/${encodeURIComponent(ticker.toLowerCase())}/prices`,
      {
        startDate: TiingoAdapter.formatDate(startDate),
        endDate: TiingoAdapter.formatDate(endDate),
      },
    );
    if (!raw) return [];
    const tk = ticker.toUpperCase();
    return raw.map((d) => ({
      ticker: tk,
      timestamp: new Date(d.date),
      open: d.adjOpen ?? d.open,
      high: d.adjHigh ?? d.high,
      low: d.adjLow ?? d.low,
      close: d.adjClose ?? d.close,
      volume: d.adjVolume ?? d.volume,
      timeframe: 'day',
      source: 'tiingo',
    }));
  }

  /** Raw daily prices pass-through (for callers that need unadjusted fields). */
  async getDailyPricesRaw(
    ticker: string,
    startDate: Date,
    endDate: Date,
  ): Promise<TiingoDailyPrice[]> {
    const raw = await this.get<TiingoDailyPrice[]>(
      `/tiingo/daily/${encodeURIComponent(ticker.toLowerCase())}/prices`,
      {
        startDate: TiingoAdapter.formatDate(startDate),
        endDate: TiingoAdapter.formatDate(endDate),
      },
    );
    return raw ?? [];
  }

  async getMeta(ticker: string): Promise<TiingoMeta | null> {
    const raw = await this.get<TiingoMeta>(
      `/tiingo/daily/${encodeURIComponent(ticker.toLowerCase())}`,
    );
    return raw;
  }

  /**
   * Download + parse https://apimedia.tiingo.com/docs/tiingo/daily/supported_tickers.zip.
   *
   * No auth, no rate limit — hits the static CDN. On 5xx we retry exactly
   * once after a short backoff; on repeat failure we throw so callers can
   * distinguish a transient wobble from a real outage (the ticker-universe
   * seed job surfaces the error and leaves existing rows untouched).
   *
   * Filter defaults to active common stock. Set
   * `{ activeCommonStockOnly: false }` for the full raw CSV.
   */
  async downloadSupportedTickers(
    opts: DownloadSupportedTickersOptions = {},
  ): Promise<TiingoSupportedTicker[]> {
    const fetchImpl = opts.fetchImpl ?? this.fetchImpl;
    const activeCommonOnly = opts.activeCommonStockOnly ?? true;

    const buf = await fetchZipWithRetry(fetchImpl);
    const zip = await JSZip.loadAsync(buf);

    // The zip contains exactly one CSV (supported_tickers.csv) — but we look
    // up by suffix to tolerate a future rename.
    const csvEntry = Object.values(zip.files).find(
      (f) => !f.dir && f.name.toLowerCase().endsWith('.csv'),
    );
    if (!csvEntry) {
      throw new Error('tiingo supported_tickers.zip contained no CSV entry');
    }
    const csv = await csvEntry.async('string');

    const rows = parseSupportedTickersCsv(csv);
    if (!activeCommonOnly) return rows;
    return activeCommonStockRows(rows);
  }
}

const ACTIVE_END_DATE_LAG_MS = 10 * 24 * 60 * 60 * 1000;

/**
 * Tiingo changed supported_tickers.csv from blank end dates for active symbols
 * to each symbol's latest available price date. Use the newest stock date in
 * the same snapshot as the clock so weekends, holidays, and a stale CDN file
 * do not make the universe disappear again.
 */
function activeCommonStockRows(rows: TiingoSupportedTicker[]): TiingoSupportedTicker[] {
  const stocks = rows.filter((row) => row.assetType === 'Stock');
  let newestEndDateMs: number | null = null;
  for (const row of stocks) {
    if (!row.endDate) continue;
    const timestamp = Date.parse(`${row.endDate}T00:00:00Z`);
    if (!Number.isFinite(timestamp)) continue;
    newestEndDateMs = newestEndDateMs === null ? timestamp : Math.max(newestEndDateMs, timestamp);
  }

  return stocks.filter((row) => {
    if (!row.endDate) return true;
    if (newestEndDateMs === null) return false;
    const timestamp = Date.parse(`${row.endDate}T00:00:00Z`);
    return Number.isFinite(timestamp) && timestamp >= newestEndDateMs - ACTIVE_END_DATE_LAG_MS;
  });
}

/**
 * Lightweight CSV parser tailored to the supported_tickers.csv format.
 *
 * The file has 6 columns, no quoted fields containing commas, no embedded
 * newlines. A naive line-split + comma-split is safe here — verified against
 * the live file on 2026-04-21. If Tiingo ever introduces quoted fields we'll
 * need to swap in a real CSV parser.
 */
function parseSupportedTickersCsv(csv: string): TiingoSupportedTicker[] {
  const out: TiingoSupportedTicker[] = [];
  // Split on \r?\n to handle both Unix + Windows line endings.
  const lines = csv.split(/\r?\n/);
  if (lines.length === 0) return out;
  // Skip header (lines[0]).
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const parts = line.split(',');
    if (parts.length < 6) continue;
    const ticker = parts[0] ?? '';
    const exchange = parts[1] ?? '';
    const assetType = parts[2] ?? '';
    const priceCurrency = parts[3] ?? '';
    const startDate = parts[4] ?? '';
    const endDate = parts[5] ?? '';
    if (!ticker) continue;
    out.push({
      ticker: ticker.toUpperCase(),
      exchange,
      assetType,
      priceCurrency,
      startDate,
      endDate,
    });
  }
  return out;
}

async function fetchZipWithRetry(fetchImpl: typeof fetch): Promise<ArrayBuffer> {
  let attempt = 0;
  let lastErr: unknown = null;
  // Max 2 tries total — one retry on transient 5xx / network error.
  while (attempt < 2) {
    attempt++;
    try {
      const res = await fetchImpl(SUPPORTED_TICKERS_URL);
      if (res.status >= 500) {
        lastErr = new Error(`tiingo supported_tickers: HTTP ${res.status}`);
      } else if (!res.ok) {
        throw new Error(`tiingo supported_tickers: HTTP ${res.status}`);
      } else {
        return await res.arrayBuffer();
      }
    } catch (err) {
      lastErr = err;
    }
    if (attempt < 2) {
      // Short backoff before the single retry.
      await new Promise((r) => setTimeout(r, 750));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('tiingo supported_tickers: unknown error');
}
