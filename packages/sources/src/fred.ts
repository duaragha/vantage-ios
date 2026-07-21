/**
 * FRED adapter — St. Louis Fed macro series.
 *
 * Base URL:  https://api.stlouisfed.org/fred
 * Auth:      ?api_key=<key>&file_type=json
 * Rate:      Generous; 120/min is safely within undocumented soft limits.
 *
 * Shortcut series IDs:
 *   DGS10     — 10-Year Treasury Constant Maturity Rate
 *   FEDFUNDS  — Effective Federal Funds Rate
 *   UNRATE    — Unemployment Rate
 *   CPIAUCSL  — CPI for All Urban Consumers: All Items
 *   VIXCLS    — CBOE Volatility Index (VIX)
 */

import { RateLimiter } from './rate-limit.js';

const BASE_URL = 'https://api.stlouisfed.org/fred';

export class FredAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FredAuthError';
  }
}

export const FRED_SERIES = {
  DGS10: 'DGS10',
  FEDFUNDS: 'FEDFUNDS',
  UNRATE: 'UNRATE',
  CPIAUCSL: 'CPIAUCSL',
  VIXCLS: 'VIXCLS',
  // Phase 16 — multi-currency / Canadian coverage.
  /** Canadian dollars per US dollar — business-day daily. */
  DEXCAUS: 'DEXCAUS',
  /** Canadian immediate (call money) rate — monthly. Used as a proxy for
   *  the Bank of Canada overnight rate for rate-sensitive thesis signals. */
  IRSTCI01CAM156N: 'IRSTCI01CAM156N',
} as const;

export type FredShortcut = keyof typeof FRED_SERIES;

export interface FredObservation {
  date: string; // YYYY-MM-DD
  value: string; // Fed returns value as string; "." means missing
  realtime_start: string;
  realtime_end: string;
}

export interface FredObservationsResponse {
  observations: FredObservation[];
  count: number;
  offset: number;
  limit: number;
}

export interface FredAdapterOptions {
  apiKey?: string;
  rateLimiter?: RateLimiter;
  fetchImpl?: typeof fetch;
}

/** Parsed observation (numeric value, `null` if Fed reported a gap). */
export interface FredPoint {
  date: Date;
  value: number | null;
  seriesId: string;
}

export class FredAdapter {
  readonly name = 'fred';
  readonly rateLimit = { perMinute: 120 };
  private readonly apiKey: string;
  private readonly limiter: RateLimiter;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: FredAdapterOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.FRED_API_KEY;
    if (!apiKey) {
      throw new FredAuthError('FRED_API_KEY is not set');
    }
    this.apiKey = apiKey;
    this.limiter = opts.rateLimiter ?? new RateLimiter({ perMinute: 120 });
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async get<T>(path: string, params: Record<string, string | number>): Promise<T | null> {
    await this.limiter.acquire();
    const url = new URL(`${BASE_URL}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    url.searchParams.set('api_key', this.apiKey);
    url.searchParams.set('file_type', 'json');
    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), { headers: { Accept: 'application/json' } });
    } catch (err) {
      console.warn(`[fred] network error on ${path}:`, err);
      return null;
    }
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      // FRED returns 400 with a descriptive body on bad keys
      const body = await res.text();
      if (body.toLowerCase().includes('api_key')) {
        throw new FredAuthError(`fred auth failed (${res.status}): ${body.slice(0, 200)}`);
      }
      console.warn(`[fred] ${res.status} on ${path}: ${body.slice(0, 200)}`);
      return null;
    }
    if (res.status === 429 || res.status >= 500) {
      console.warn(`[fred] soft failure ${res.status} on ${path}`);
      return null;
    }
    if (!res.ok) {
      console.warn(`[fred] unexpected ${res.status} on ${path}`);
      return null;
    }
    return (await res.json()) as T;
  }

  /** Fetch raw observations. */
  async getSeries(seriesId: string, limit = 100): Promise<FredPoint[]> {
    const raw = await this.get<FredObservationsResponse>('/series/observations', {
      series_id: seriesId,
      limit,
      sort_order: 'desc',
    });
    if (!raw) return [];
    return raw.observations.map((o) => ({
      date: new Date(`${o.date}T00:00:00Z`),
      value: o.value === '.' ? null : Number.parseFloat(o.value),
      seriesId,
    }));
  }

  get10YearTreasury(limit = 30): Promise<FredPoint[]> {
    return this.getSeries(FRED_SERIES.DGS10, limit);
  }

  getFedFunds(limit = 30): Promise<FredPoint[]> {
    return this.getSeries(FRED_SERIES.FEDFUNDS, limit);
  }

  getUnemploymentRate(limit = 30): Promise<FredPoint[]> {
    return this.getSeries(FRED_SERIES.UNRATE, limit);
  }

  getCpi(limit = 30): Promise<FredPoint[]> {
    return this.getSeries(FRED_SERIES.CPIAUCSL, limit);
  }

  getVix(limit = 30): Promise<FredPoint[]> {
    return this.getSeries(FRED_SERIES.VIXCLS, limit);
  }

  /** DEXCAUS — CAD per USD, daily business-day. */
  getUsdCadRate(limit = 30): Promise<FredPoint[]> {
    return this.getSeries(FRED_SERIES.DEXCAUS, limit);
  }

  /** IRSTCI01CAM156N — Canadian immediate call money rate, monthly. */
  getBocRate(limit = 30): Promise<FredPoint[]> {
    return this.getSeries(FRED_SERIES.IRSTCI01CAM156N, limit);
  }
}
