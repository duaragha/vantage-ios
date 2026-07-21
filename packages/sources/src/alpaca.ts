/**
 * Alpaca adapter — REST + WebSocket.
 *
 * The official `@alpacahq/alpaca-trade-api` SDK was last updated Jan 2025 and
 * has a history of being stale; hand-rolled fetch + `ws` is cleaner in April 2026.
 *
 * REST base URLs:
 *   Trading (paper):   https://paper-api.alpaca.markets
 *   Market data:       https://data.alpaca.markets
 *
 * WebSocket:
 *   IEX feed:          wss://stream.data.alpaca.markets/v2/iex
 *
 * Auth headers: APCA-API-KEY-ID, APCA-API-SECRET-KEY
 * Rate limit: 200/min.
 */

import WebSocket from 'ws';
import { RateLimiter } from './rate-limit.js';
import type { NormalizedBar, NormalizedQuote } from './types.js';

// Paper trading endpoint — wired up for future order-status / account calls.
// Prefixed with `_` so the unused-var lint stays clean until Phase 6+ needs it.
const _TRADING_BASE = 'https://paper-api.alpaca.markets';
void _TRADING_BASE;
const DATA_BASE = 'https://data.alpaca.markets';
const STREAM_IEX = 'wss://stream.data.alpaca.markets/v2/iex';

export class AlpacaAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AlpacaAuthError';
  }
}

/** Raw /v2/stocks/{symbol}/quotes/latest shape (subset). */
interface AlpacaLatestQuoteResponse {
  quote: {
    ap: number; // ask price
    as: number; // ask size
    bp: number; // bid price
    bs: number; // bid size
    t: string; // RFC3339 timestamp
  };
  symbol: string;
}

/** Raw /v2/stocks/{symbol}/trades/latest shape (subset). */
interface AlpacaLatestTradeResponse {
  trade: {
    p: number;
    s: number;
    t: string;
  };
  symbol: string;
}

/**
 * Raw /v2/stocks/{symbol}/snapshot shape (subset). One call returns the latest
 * trade AND today's daily bar (open/high/low/close so far), so the day-trade
 * scanner can anchor entries to TODAY's intraday levels instead of a multi-day
 * DailyBar high. `dailyBar` is the current session's bar; on IEX it builds up
 * through the day (partial volume, real-time-ish).
 */
interface AlpacaSnapshotResponse {
  latestTrade?: { p: number; s: number; t: string };
  dailyBar?: { o: number; h: number; l: number; c: number; v: number; t: string };
  prevDailyBar?: { o: number; h: number; l: number; c: number; v: number; t: string };
}

const SNAPSHOT_BATCH_SIZE = 100;
const BAR_BATCH_SIZE = 100;
const MAX_BAR_PAGES_PER_BATCH = 100;

function normalizeSnapshot(
  ticker: string,
  raw: AlpacaSnapshotResponse | null | undefined,
): AlpacaSnapshot | null {
  if (!raw) return null;
  const trade = raw.latestTrade;
  const day = raw.dailyBar;
  const previous = raw.prevDailyBar;
  const last = typeof trade?.p === 'number' ? trade.p : null;
  if (last === null && !day) return null;
  return {
    ticker: ticker.toUpperCase(),
    last,
    lastTradeSize: typeof trade?.s === 'number' ? trade.s : null,
    dayOpen: typeof day?.o === 'number' ? day.o : null,
    dayHigh: typeof day?.h === 'number' ? day.h : null,
    dayLow: typeof day?.l === 'number' ? day.l : null,
    dayClose: typeof day?.c === 'number' ? day.c : null,
    dayVolume: typeof day?.v === 'number' ? day.v : null,
    prevClose: typeof previous?.c === 'number' ? previous.c : null,
    timestamp: trade?.t ? new Date(trade.t) : new Date(),
    source: 'alpaca',
  };
}

/** Normalized snapshot: latest trade + today's daily OHLC (all best-effort). */
export interface AlpacaSnapshot {
  ticker: string;
  /** Latest trade price; null when Alpaca returned no trade. */
  last: number | null;
  /** Share count on the latest trade; null when no trade was returned. */
  lastTradeSize: number | null;
  /** Today's open / high / low / close-so-far; null when no daily bar yet. */
  dayOpen: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  dayClose: number | null;
  /** Current session volume on the selected Alpaca feed. */
  dayVolume: number | null;
  /** Prior session's close — the % move base when today's open is absent. */
  prevClose: number | null;
  /** Timestamp of the latest trade (falls back to now). */
  timestamp: Date;
  source: 'alpaca';
}

interface AlpacaWireBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface AlpacaBarsResponse {
  bars: AlpacaWireBar[];
  next_page_token: string | null;
  symbol: string;
}

interface AlpacaMultiBarsResponse {
  bars: Record<string, AlpacaWireBar[]>;
  next_page_token: string | null;
}

function normalizeBar(ticker: string, timeframe: BarTimeframe, bar: AlpacaWireBar): NormalizedBar {
  return {
    ticker: ticker.toUpperCase(),
    timestamp: new Date(bar.t),
    open: bar.o,
    high: bar.h,
    low: bar.l,
    close: bar.c,
    volume: bar.v,
    timeframe,
    source: 'alpaca',
  };
}

/** Events emitted by the streaming subscription. */
export type AlpacaStreamEvent =
  | {
      kind: 'trade';
      ticker: string;
      price: number;
      size: number;
      timestamp: Date;
    }
  | {
      kind: 'quote';
      ticker: string;
      bid: number;
      ask: number;
      timestamp: Date;
    };

export type AlpacaStreamHandler = (event: AlpacaStreamEvent) => void;

export interface AlpacaSubscription {
  close: () => void;
}

export interface AlpacaAdapterOptions {
  keyId?: string;
  secretKey?: string;
  rateLimiter?: RateLimiter;
  fetchImpl?: typeof fetch;
}

export type BarTimeframe = '1Min' | '5Min' | '15Min' | '1Hour' | '1Day';

export class AlpacaAdapter {
  readonly name = 'alpaca';
  readonly rateLimit = { perMinute: 200 };
  private readonly keyId: string;
  private readonly secretKey: string;
  private readonly limiter: RateLimiter;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AlpacaAdapterOptions = {}) {
    const keyId = opts.keyId ?? process.env.ALPACA_KEY_ID;
    const secretKey = opts.secretKey ?? process.env.ALPACA_SECRET_KEY;
    if (!keyId || !secretKey) {
      throw new AlpacaAuthError('ALPACA_KEY_ID / ALPACA_SECRET_KEY are not set');
    }
    this.keyId = keyId;
    this.secretKey = secretKey;
    this.limiter = opts.rateLimiter ?? new RateLimiter({ perMinute: 200 });
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    return {
      'APCA-API-KEY-ID': this.keyId,
      'APCA-API-SECRET-KEY': this.secretKey,
      Accept: 'application/json',
    };
  }

  private async get<T>(
    base: string,
    path: string,
    params?: Record<string, string | number>,
  ): Promise<T | null> {
    await this.limiter.acquire();
    const url = new URL(`${base}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    }
    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), { headers: this.headers() });
    } catch (err) {
      console.warn(`[alpaca] network error on ${path}:`, err);
      return null;
    }
    if (res.status === 401 || res.status === 403) {
      throw new AlpacaAuthError(`alpaca auth failed (${res.status}) on ${path}`);
    }
    if (res.status === 404) {
      return null;
    }
    if (res.status === 429 || res.status >= 500) {
      console.warn(`[alpaca] soft failure ${res.status} on ${path}`);
      return null;
    }
    if (!res.ok) {
      console.warn(`[alpaca] unexpected ${res.status} on ${path}`);
      return null;
    }
    return (await res.json()) as T;
  }

  /** Latest quote for a single ticker via REST. */
  async getLatestQuote(ticker: string): Promise<NormalizedQuote | null> {
    const raw = await this.get<AlpacaLatestQuoteResponse>(
      DATA_BASE,
      `/v2/stocks/${encodeURIComponent(ticker)}/quotes/latest`,
    );
    if (!raw?.quote) return null;
    return {
      ticker: ticker.toUpperCase(),
      bid: raw.quote.bp ?? null,
      ask: raw.quote.ap ?? null,
      last: null,
      timestamp: new Date(raw.quote.t),
      source: 'alpaca',
    };
  }

  /** Latest trade for a single ticker via REST. */
  async getLatestTrade(ticker: string): Promise<NormalizedQuote | null> {
    const raw = await this.get<AlpacaLatestTradeResponse>(
      DATA_BASE,
      `/v2/stocks/${encodeURIComponent(ticker)}/trades/latest`,
    );
    if (!raw?.trade) return null;
    return {
      ticker: ticker.toUpperCase(),
      bid: null,
      ask: null,
      last: raw.trade.p,
      timestamp: new Date(raw.trade.t),
      source: 'alpaca',
    };
  }

  /**
   * Snapshot for a single ticker — latest trade + today's daily bar in ONE call
   * (same 1-request rate cost as getLatestTrade). Returns null only on a hard
   * miss; partial data (e.g. a trade but no daily bar early in the session) comes
   * back with the missing fields null so the caller can decide.
   *
   * Extended hours: the IEX `latestTrade` already reflects the most recent IEX
   * print INCLUDING pre/after-market — no extra param is needed for the REST
   * snapshot (the caller persists `timestamp` so a price's session is labeled by
   * the actual trade time). IEX is a single venue, so extended-hours coverage is
   * partial for thin names; full consolidated extended-hours = the paid SIP feed.
   */
  async getSnapshot(ticker: string): Promise<AlpacaSnapshot | null> {
    const raw = await this.get<AlpacaSnapshotResponse>(
      DATA_BASE,
      `/v2/stocks/${encodeURIComponent(ticker)}/snapshot`,
      { feed: 'iex' },
    );
    return normalizeSnapshot(ticker, raw);
  }

  /**
   * Snapshot lookup for many US tickers. Alpaca accepts a comma-separated
   * symbol list, so chunking 100 names keeps URLs bounded while collapsing the
   * scanner's hundreds of single-symbol requests into a few API calls.
   */
  async getSnapshots(tickers: readonly string[]): Promise<Map<string, AlpacaSnapshot>> {
    const symbols = Array.from(
      new Set(tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean)),
    );
    const out = new Map<string, AlpacaSnapshot>();
    for (let offset = 0; offset < symbols.length; offset += SNAPSHOT_BATCH_SIZE) {
      const batch = symbols.slice(offset, offset + SNAPSHOT_BATCH_SIZE);
      const raw = await this.get<Record<string, AlpacaSnapshotResponse>>(
        DATA_BASE,
        '/v2/stocks/snapshots',
        { symbols: batch.join(','), feed: 'iex' },
      );
      if (!raw) continue;
      for (const ticker of batch) {
        const snapshot = normalizeSnapshot(ticker, raw[ticker]);
        if (snapshot) out.set(ticker, snapshot);
      }
    }
    return out;
  }

  /**
   * Bars (minute/day/etc). Pagination auto-follows until `next_page_token` is null.
   * Caps at 10k bars to avoid runaway loops.
   */
  async getBars(
    ticker: string,
    timeframe: BarTimeframe,
    start: Date,
    end: Date,
  ): Promise<NormalizedBar[]> {
    const out: NormalizedBar[] = [];
    let pageToken: string | undefined = undefined;
    const MAX = 10_000;
    while (out.length < MAX) {
      const params: Record<string, string> = {
        timeframe,
        start: start.toISOString(),
        end: end.toISOString(),
        limit: '1000',
        adjustment: 'all',
        feed: 'iex',
      };
      if (pageToken) params.page_token = pageToken;
      const raw: AlpacaBarsResponse | null = await this.get<AlpacaBarsResponse>(
        DATA_BASE,
        `/v2/stocks/${encodeURIComponent(ticker)}/bars`,
        params,
      );
      if (!raw) break;
      for (const b of raw.bars ?? []) {
        out.push(normalizeBar(ticker, timeframe, b));
      }
      if (!raw.next_page_token) break;
      pageToken = raw.next_page_token;
    }
    return out;
  }

  /**
   * Historical bars for many US symbols through Alpaca's multi-symbol
   * endpoint. Symbols are chunked to keep request URLs bounded, and every
   * page token is followed because the API's limit is across the whole batch.
   */
  async getMultiBars(
    tickers: readonly string[],
    timeframe: BarTimeframe,
    start: Date,
    end: Date,
  ): Promise<Map<string, NormalizedBar[]>> {
    const symbols = Array.from(
      new Set(tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean)),
    );
    const out = new Map<string, NormalizedBar[]>();
    for (let offset = 0; offset < symbols.length; offset += BAR_BATCH_SIZE) {
      const batch = symbols.slice(offset, offset + BAR_BATCH_SIZE);
      let pageToken: string | undefined;
      const seenPageTokens = new Set<string>();
      let pageCount = 0;
      do {
        pageCount++;
        const params: Record<string, string> = {
          symbols: batch.join(','),
          timeframe,
          start: start.toISOString(),
          end: end.toISOString(),
          limit: '10000',
          adjustment: 'all',
          feed: 'iex',
        };
        if (pageToken) params.page_token = pageToken;
        const raw = await this.get<AlpacaMultiBarsResponse>(DATA_BASE, '/v2/stocks/bars', params);
        if (!raw) break;
        for (const [ticker, bars] of Object.entries(raw.bars ?? {})) {
          const upper = ticker.toUpperCase();
          const bucket = out.get(upper) ?? [];
          for (const bar of bars) bucket.push(normalizeBar(upper, timeframe, bar));
          out.set(upper, bucket);
        }
        const nextPageToken = raw.next_page_token ?? undefined;
        if (nextPageToken && seenPageTokens.has(nextPageToken)) {
          console.warn('[alpaca] repeated page token on multi-symbol bars; stopping batch');
          break;
        }
        if (nextPageToken) seenPageTokens.add(nextPageToken);
        pageToken = nextPageToken;
      } while (pageToken && pageCount < MAX_BAR_PAGES_PER_BATCH);
      if (pageToken && pageCount >= MAX_BAR_PAGES_PER_BATCH) {
        console.warn('[alpaca] multi-symbol bars reached pagination safety limit');
      }
    }
    return out;
  }

  /**
   * Subscribe to trades + quotes for a set of tickers over the IEX websocket.
   * `handler` receives normalized events. Returns an object with `close()` for
   * cleanup.
   */
  subscribe(tickers: string[], handler: AlpacaStreamHandler): AlpacaSubscription {
    if (tickers.length === 0) {
      throw new Error('alpaca.subscribe: tickers must be non-empty');
    }
    const ws = new WebSocket(STREAM_IEX);
    const symbols = tickers.map((t) => t.toUpperCase());
    let closedByUser = false;

    const onOpen = (): void => {
      ws.send(
        JSON.stringify({
          action: 'auth',
          key: this.keyId,
          secret: this.secretKey,
        }),
      );
    };

    const onMessage = (data: WebSocket.RawData): void => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return;
      }
      const msgs = Array.isArray(parsed) ? parsed : [parsed];
      for (const m of msgs) {
        if (!isAlpacaMsg(m)) continue;
        if (m.T === 'success' && m.msg === 'authenticated') {
          ws.send(
            JSON.stringify({
              action: 'subscribe',
              trades: symbols,
              quotes: symbols,
            }),
          );
          continue;
        }
        if (m.T === 'error') {
          const code = typeof m.code === 'number' ? m.code : undefined;
          // 402/401-equivalent codes from Alpaca stream
          if (code === 402 || code === 401 || code === 403) {
            ws.close();
            throw new AlpacaAuthError(`alpaca stream auth error: ${m.msg ?? 'unknown'}`);
          }
          console.warn('[alpaca] stream error', m);
          continue;
        }
        if (m.T === 't' && typeof m.S === 'string' && typeof m.p === 'number') {
          handler({
            kind: 'trade',
            ticker: m.S,
            price: m.p,
            size: typeof m.s === 'number' ? m.s : 0,
            timestamp: new Date(typeof m.t === 'string' ? m.t : Date.now()),
          });
        } else if (
          m.T === 'q' &&
          typeof m.S === 'string' &&
          typeof m.bp === 'number' &&
          typeof m.ap === 'number'
        ) {
          handler({
            kind: 'quote',
            ticker: m.S,
            bid: m.bp,
            ask: m.ap,
            timestamp: new Date(typeof m.t === 'string' ? m.t : Date.now()),
          });
        }
      }
    };

    const onError = (err: Error): void => {
      console.warn('[alpaca] stream error:', err.message);
    };
    const onClose = (): void => {
      if (!closedByUser) {
        console.warn('[alpaca] stream closed unexpectedly');
      }
    };

    ws.on('open', onOpen);
    ws.on('message', onMessage);
    ws.on('error', onError);
    ws.on('close', onClose);

    return {
      close: () => {
        closedByUser = true;
        try {
          ws.close();
        } catch {
          /* noop */
        }
      },
    };
  }
}

interface AlpacaWireMsg {
  T: string;
  msg?: string;
  code?: number;
  S?: string;
  p?: number;
  s?: number;
  bp?: number;
  ap?: number;
  t?: string;
}

function isAlpacaMsg(m: unknown): m is AlpacaWireMsg {
  return (
    typeof m === 'object' && m !== null && 'T' in m && typeof (m as { T: unknown }).T === 'string'
  );
}
