/**
 * Price oracle — exchange-aware fallback chain.
 *
 * Phase 16 routing:
 *   US listings (no suffix) → Alpaca → Finnhub → yfinance → Tiingo
 *   TSX / NEO / TSX-V      → yfinance → Finnhub → Tiingo
 *
 * Alpaca is IEX-only (US) and Finnhub's free tier rejects `.TO` / `.NE` / `.V`
 * symbols with 403 — both are skipped (or best-effort) for Canadian routes.
 * yfinance is the most reliable free source for TSX realtime-ish quotes.
 *
 * Each `PriceResult` carries a `currency` field (USD for US, CAD for TO/NE/V)
 * so downstream portfolio math can convert via `packages/core/src/fx.ts`.
 *
 * The oracle looks up the ticker's exchange in TickerUniverse to decide the
 * route. Lookups are cached per-process for 10 minutes to avoid a DB call on
 * every price fetch — the universe is refreshed weekly, so stale cache is
 * fine. Missing rows fall back to US routing with a warn log (rebalance
 * flows gracefully degrade rather than crashing on an unknown ticker).
 *
 * In-memory price cache keyed by ticker, 60s TTL — unchanged from the pre-
 * Phase-16 oracle. Two bulk calls within a minute won't hit any adapter more
 * than once.
 */

import type {
  AlpacaAdapter,
  FinnhubAdapter,
  TiingoAdapter,
  YFinanceAdapter,
} from '@vantage/sources';
import { exchangeFromSymbol, isCaExchange, deriveCurrency } from '@vantage/sources';

export type PriceSource = 'alpaca' | 'finnhub' | 'tiingo' | 'twelvedata' | 'yfinance';
export type PriceCurrency = 'USD' | 'CAD';

export interface PriceResult {
  price: number;
  source: PriceSource;
  asOf: Date;
  /** Reporting currency of the listing. */
  currency: PriceCurrency;
  /**
   * Exchange code this result applies to. US | TO | NE | V. Derived from the
   * ticker suffix + TickerUniverse lookup.
   */
  exchange: string;
}

export interface PriceOracle {
  getLatestPrice(ticker: string): Promise<PriceResult | null>;
  getLatestPrices(tickers: ReadonlyArray<string>): Promise<Record<string, PriceResult | null>>;
  /** Seed or overwrite the cache (useful for tests). */
  setCached(ticker: string, result: PriceResult | null): void;
  /** Clear all cached entries. */
  clear(): void;
}

/**
 * Exchange lookup — abstracted so tests can stub it without pulling in the
 * full `@vantage/db` import surface.
 */
export type ExchangeLookup = (ticker: string) => Promise<string | null>;

export interface PriceOracleDeps {
  alpaca?: AlpacaAdapter | null;
  finnhub?: FinnhubAdapter | null;
  tiingo?: TiingoAdapter | null;
  yfinance?: YFinanceAdapter | null;
  /**
   * Given a ticker, return its exchange code from TickerUniverse. Defaults to
   * a stub that returns null — which routes everything as US (backward
   * compat). The worker wires a real DB-backed lookup.
   */
  exchangeLookup?: ExchangeLookup;
  /** Override `Date.now()` for testable TTL (returns ms). */
  now?: () => number;
  /** Price cache TTL in ms. Defaults to 60_000 (60s). */
  ttlMs?: number;
  /** Exchange lookup cache TTL. Defaults to 10 minutes. */
  exchangeCacheTtlMs?: number;
  logger?: {
    warn?: (obj: unknown, msg?: string) => void;
    debug?: (obj: unknown, msg?: string) => void;
  };
}

interface CacheEntry {
  value: PriceResult | null;
  expiresAt: number;
}

interface ExchangeCacheEntry {
  exchange: string;
  expiresAt: number;
}

export class DefaultPriceOracle implements PriceOracle {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly exchangeCache = new Map<string, ExchangeCacheEntry>();
  private readonly alpaca: AlpacaAdapter | null;
  private readonly finnhub: FinnhubAdapter | null;
  private readonly tiingo: TiingoAdapter | null;
  private readonly yfinance: YFinanceAdapter | null;
  private readonly exchangeLookup: ExchangeLookup;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly exchangeCacheTtlMs: number;
  private readonly logger: PriceOracleDeps['logger'];

  constructor(deps: PriceOracleDeps = {}) {
    this.alpaca = deps.alpaca ?? null;
    this.finnhub = deps.finnhub ?? null;
    this.tiingo = deps.tiingo ?? null;
    this.yfinance = deps.yfinance ?? null;
    this.exchangeLookup = deps.exchangeLookup ?? (async () => null);
    this.now = deps.now ?? Date.now;
    this.ttlMs = deps.ttlMs ?? 60_000;
    this.exchangeCacheTtlMs = deps.exchangeCacheTtlMs ?? 10 * 60_000;
    this.logger = deps.logger;
  }

  setCached(ticker: string, result: PriceResult | null): void {
    this.cache.set(ticker.toUpperCase(), {
      value: result,
      expiresAt: this.now() + this.ttlMs,
    });
  }

  clear(): void {
    this.cache.clear();
    this.exchangeCache.clear();
  }

  async getLatestPrice(ticker: string): Promise<PriceResult | null> {
    const key = ticker.toUpperCase();
    const cached = this.cache.get(key);
    const t = this.now();
    if (cached && cached.expiresAt > t) {
      return cached.value;
    }

    const exchange = await this.resolveExchange(key);
    const result = await this.tryChain(key, exchange);
    this.cache.set(key, { value: result, expiresAt: t + this.ttlMs });
    return result;
  }

  async getLatestPrices(
    tickers: ReadonlyArray<string>,
  ): Promise<Record<string, PriceResult | null>> {
    const out: Record<string, PriceResult | null> = {};
    // Sequential — adapters have per-minute rate limiters. With caching on
    // top, a typical rebalance pass (≤ 20 tickers) fits in well under 1s.
    for (const t of tickers) {
      out[t.toUpperCase()] = await this.getLatestPrice(t);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Exchange resolution
  // -------------------------------------------------------------------------

  /**
   * Figure out which exchange a ticker trades on. Suffix always wins — if the
   * symbol ends in `.TO`/`.NE`/`.V` we don't even hit the DB. Otherwise we
   * ask the exchangeLookup (typically a TickerUniverse read). Null rows from
   * the lookup fall through to US.
   */
  private async resolveExchange(ticker: string): Promise<string> {
    const fromSuffix = exchangeFromSymbol(ticker);
    if (fromSuffix !== 'US') return fromSuffix;

    const t = this.now();
    const cached = this.exchangeCache.get(ticker);
    if (cached && cached.expiresAt > t) return cached.exchange;

    let resolved = 'US';
    try {
      const row = await this.exchangeLookup(ticker);
      if (row) resolved = row;
    } catch (err) {
      this.logger?.warn?.(
        { ticker, err: err instanceof Error ? err.message : err },
        '[priceOracle] exchange lookup threw — defaulting to US',
      );
    }
    this.exchangeCache.set(ticker, {
      exchange: resolved,
      expiresAt: t + this.exchangeCacheTtlMs,
    });
    return resolved;
  }

  // -------------------------------------------------------------------------
  // Fallback chain
  // -------------------------------------------------------------------------

  private async tryChain(ticker: string, exchange: string): Promise<PriceResult | null> {
    const currency = deriveCurrency(exchange);
    const isCa = isCaExchange(exchange);

    // --- Canadian route ---------------------------------------------------
    if (isCa) {
      if (this.yfinance) {
        try {
          const q = await this.yfinance.getQuote(ticker);
          if (q?.last && q.last > 0) {
            return {
              price: q.last,
              source: 'yfinance',
              asOf: q.timestamp,
              currency,
              exchange,
            };
          }
        } catch (err) {
          this.logger?.warn?.(
            { ticker, err: err instanceof Error ? err.message : err },
            '[priceOracle] yfinance threw — falling through',
          );
        }
      }
      // Tiingo intermittently returns CAD listings; leave it as a last resort.
      if (this.tiingo) {
        try {
          const end = new Date();
          const start = new Date(end.getTime() - 7 * 24 * 3600_000);
          const bars = await this.tiingo.getDailyPrices(ticker, start, end);
          if (bars.length > 0) {
            const last = bars[bars.length - 1]!;
            if (last.close > 0) {
              return {
                price: last.close,
                source: 'tiingo',
                asOf: last.timestamp,
                currency,
                exchange,
              };
            }
          }
        } catch (err) {
          this.logger?.warn?.(
            { ticker, err: err instanceof Error ? err.message : err },
            '[priceOracle] tiingo threw — no more fallbacks',
          );
        }
      }
      this.logger?.debug?.(
        { ticker, exchange },
        '[priceOracle] CA route — all providers returned null',
      );
      return null;
    }

    // --- US route ---------------------------------------------------------
    // 1. Alpaca latest trade
    if (this.alpaca) {
      try {
        const q = await this.alpaca.getLatestTrade(ticker);
        if (q?.last && q.last > 0) {
          return {
            price: q.last,
            source: 'alpaca',
            asOf: q.timestamp,
            currency,
            exchange,
          };
        }
      } catch (err) {
        this.logger?.warn?.(
          { ticker, err: err instanceof Error ? err.message : err },
          '[priceOracle] alpaca threw — falling through',
        );
      }
    }

    // 2. Finnhub quote
    if (this.finnhub) {
      try {
        const q = await this.finnhub.getQuote(ticker);
        if (q && typeof q.c === 'number' && q.c > 0) {
          return {
            price: q.c,
            source: 'finnhub',
            asOf: new Date(q.t * 1000),
            currency,
            exchange,
          };
        }
      } catch (err) {
        this.logger?.warn?.(
          { ticker, err: err instanceof Error ? err.message : err },
          '[priceOracle] finnhub threw — falling through',
        );
      }
    }

    // 3. yfinance quote
    if (this.yfinance) {
      try {
        const q = await this.yfinance.getQuote(ticker);
        if (q?.last && q.last > 0) {
          return {
            price: q.last,
            source: 'yfinance',
            asOf: q.timestamp,
            currency,
            exchange,
          };
        }
      } catch (err) {
        this.logger?.warn?.(
          { ticker, err: err instanceof Error ? err.message : err },
          '[priceOracle] yfinance threw — falling through',
        );
      }
    }

    // 4. Tiingo EOD (last 7 days, take last bar)
    if (this.tiingo) {
      try {
        const end = new Date();
        const start = new Date(end.getTime() - 7 * 24 * 3600_000);
        const bars = await this.tiingo.getDailyPrices(ticker, start, end);
        if (bars.length > 0) {
          const last = bars[bars.length - 1]!;
          if (last.close > 0) {
            return {
              price: last.close,
              source: 'tiingo',
              asOf: last.timestamp,
              currency,
              exchange,
            };
          }
        }
      } catch (err) {
        this.logger?.warn?.(
          { ticker, err: err instanceof Error ? err.message : err },
          '[priceOracle] tiingo threw — no more fallbacks',
        );
      }
    }

    this.logger?.debug?.(
      { ticker },
      '[priceOracle] all providers returned null / threw — no price available',
    );
    return null;
  }
}

/**
 * Module-level convenience: a lazily-constructed singleton wired to the
 * real adapters via a getter so unit tests can build their own
 * DefaultPriceOracle without pulling in env-var-gated adapter constructors.
 */
let _defaultInstance: DefaultPriceOracle | null = null;

export interface AdapterGetters {
  getAlpaca?: () => AlpacaAdapter;
  getFinnhub?: () => FinnhubAdapter;
  getTiingo?: () => TiingoAdapter;
  getYFinance?: () => YFinanceAdapter;
  logger?: PriceOracleDeps['logger'];
  /**
   * Exchange lookup backed by TickerUniverse. The worker wires this via the
   * db package; callers that only need US routing can omit it.
   */
  exchangeLookup?: ExchangeLookup;
}

/**
 * Build the process-wide oracle singleton from adapter getters. Calling twice
 * with different getters is a programming error — the second call is ignored
 * so tests can't accidentally mutate the singleton mid-run.
 */
export function configurePriceOracle(getters: AdapterGetters): DefaultPriceOracle {
  if (_defaultInstance) return _defaultInstance;
  const alpaca = safeCall('alpaca', getters.getAlpaca, getters.logger);
  const finnhub = safeCall('finnhub', getters.getFinnhub, getters.logger);
  const tiingo = safeCall('tiingo', getters.getTiingo, getters.logger);
  const yfinance = safeCall('yfinance', getters.getYFinance, getters.logger);
  _defaultInstance = new DefaultPriceOracle({
    ...(alpaca ? { alpaca } : {}),
    ...(finnhub ? { finnhub } : {}),
    ...(tiingo ? { tiingo } : {}),
    ...(yfinance ? { yfinance } : {}),
    ...(getters.exchangeLookup ? { exchangeLookup: getters.exchangeLookup } : {}),
    ...(getters.logger ? { logger: getters.logger } : {}),
  });
  return _defaultInstance;
}

export function getPriceOracle(): DefaultPriceOracle {
  if (!_defaultInstance) {
    // Zero-adapter oracle — always returns null. Callers should configure
    // explicitly from the worker bootstrap.
    _defaultInstance = new DefaultPriceOracle();
  }
  return _defaultInstance;
}

/** Test hook — resets the singleton so a subsequent configure takes effect. */
export function resetPriceOracle(): void {
  _defaultInstance = null;
}

function safeCall<T>(
  provider: string,
  fn: (() => T) | undefined,
  logger?: PriceOracleDeps['logger'],
): T | null {
  if (!fn) return null;
  try {
    return fn();
  } catch (err) {
    logger?.warn?.({ provider, err }, '[priceOracle] provider disabled at startup');
    return null;
  }
}
