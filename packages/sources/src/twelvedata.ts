/**
 * Twelve Data adapter for the public Canadian ticker universe.
 *
 * Base URL:     https://api.twelvedata.com
 * Endpoints:
 *   GET /stocks?exchange={TSX|NEO|TSXV}&format=JSON  — ticker universe (public)
 *
 * The /stocks endpoint is public and does NOT require an API key as of
 * 2026-04-21 — it returns the full listing for the given exchange with
 * symbol, name, currency, MIC code, country, and type.
 *
 * Calls use a conservative one-call-per-five-seconds spacing. The universe
 * refresh only makes a few requests each week.
 *
 * TSX note: Twelve Data's TSX listing includes CDRs (Canadian Depositary
 * Receipts) — CAD-denominated wrappers around US stocks like AAPL on TSX.
 * Callers that want to flag these as dependent on the US listing should
 * pass a `knownUsSymbols` Set to `getStocksByExchange` which enables the
 * `isCdr` tag on each returned row.
 */

const BASE_URL = 'https://api.twelvedata.com';
const MIN_CALL_INTERVAL_MS = 5_000;

/** Canadian exchanges Twelve Data returns listings for. */
export type TwelveDataExchange = 'TSX' | 'NEO' | 'TSXV';

/** Raw row from Twelve Data /stocks. Kept close to the wire format. */
interface TwelveDataStocksRow {
  symbol: string;
  name: string;
  currency: string;
  exchange: string;
  mic_code: string;
  country: string;
  type: string;
}

interface TwelveDataStocksResponse {
  status?: string;
  data?: TwelveDataStocksRow[];
  code?: number;
  message?: string;
}

/** Normalized shape returned by the adapter. */
export interface TwelveDataStock {
  symbol: string;
  name: string;
  currency: string;
  exchange: string;
  mic_code: string;
  country: string;
  type: string;
  /**
   * True when this listing is likely a Canadian Depositary Receipt of a US
   * security — i.e. the bare symbol (before any `.TO` suffix) also exists in
   * the US universe. Only populated for TSX; NEO/TSXV listings don't commonly
   * carry CDRs and the detection would be noisy.
   */
  isCdr?: boolean;
}

export interface TwelveDataAdapterOptions {
  fetchImpl?: typeof fetch;
}

export interface GetStocksOptions {
  /**
   * Only used when exchange === 'TSX'. Set of US symbols (uppercase, no
   * suffix) from the Tiingo universe. Any TSX row whose bare symbol matches
   * is flagged `isCdr: true`.
   */
  knownUsSymbols?: ReadonlySet<string>;
  /**
   * Filter to operating-company equities. Defaults to true — drops ETFs,
   * preferreds, and other non-"Common Stock" types.
   */
  commonStockOnly?: boolean;
}

/** Returned by `filterCommonStock` for symmetry with other adapters. */
export function isCommonStock(row: { type: string }): boolean {
  return row.type === 'Common Stock';
}

export class TwelveDataAdapter {
  readonly name = 'twelvedata';
  private readonly fetchImpl: typeof fetch;
  private lastCallAt = 0;

  constructor(opts: TwelveDataAdapterOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastCallAt;
    if (this.lastCallAt > 0 && elapsed < MIN_CALL_INTERVAL_MS) {
      await new Promise((r) => setTimeout(r, MIN_CALL_INTERVAL_MS - elapsed));
    }
    this.lastCallAt = Date.now();
  }

  /**
   * GET /stocks?exchange={exchange}&format=JSON
   *
   * Returns the full Canadian-exchange listing. 5xx errors are retried once
   * after a short delay; anything else throws so callers can tell apart
   * "network hiccup" from "Twelve Data started gating this endpoint".
   *
   * When `exchange === 'TSX'` and `opts.knownUsSymbols` is supplied, each row
   * whose bare symbol also appears in the US universe is tagged `isCdr:true`.
   */
  async getStocksByExchange(
    exchange: TwelveDataExchange,
    opts: GetStocksOptions = {},
  ): Promise<TwelveDataStock[]> {
    const commonOnly = opts.commonStockOnly ?? true;
    const raw = await this.requestStocks(exchange);
    const rows = commonOnly ? raw.filter(isCommonStock) : raw;

    if (exchange !== 'TSX' || !opts.knownUsSymbols || opts.knownUsSymbols.size === 0) {
      return rows.map((r) => this.normalize(r));
    }

    const us = opts.knownUsSymbols;
    return rows.map((r) => {
      const bare = r.symbol.toUpperCase();
      const out = this.normalize(r);
      if (us.has(bare)) out.isCdr = true;
      return out;
    });
  }

  private normalize(row: TwelveDataStocksRow): TwelveDataStock {
    return {
      symbol: row.symbol.toUpperCase(),
      name: row.name,
      currency: row.currency,
      exchange: row.exchange,
      mic_code: row.mic_code,
      country: row.country,
      type: row.type,
    };
  }

  private async requestStocks(exchange: TwelveDataExchange): Promise<TwelveDataStocksRow[]> {
    const url = new URL(`${BASE_URL}/stocks`);
    url.searchParams.set('exchange', exchange);
    url.searchParams.set('format', 'JSON');

    let attempt = 0;
    let lastErr: unknown = null;
    while (attempt < 2) {
      attempt++;
      await this.throttle();
      try {
        const res = await this.fetchImpl(url.toString());
        if (res.status >= 500) {
          lastErr = new Error(`twelvedata /stocks ${exchange}: HTTP ${res.status}`);
        } else if (res.status === 401 || res.status === 403) {
          // Flag this explicitly — if Twelve Data starts requiring a key for
          // /stocks, we want to surface it loudly instead of silently
          // returning zero rows.
          throw new TwelveDataAuthError(
            `twelvedata /stocks ${exchange} returned ${res.status} — the endpoint may now require an API key`,
          );
        } else if (!res.ok) {
          throw new Error(`twelvedata /stocks ${exchange}: HTTP ${res.status}`);
        } else {
          const body = (await res.json()) as TwelveDataStocksResponse;
          if (body.status && body.status !== 'ok') {
            // Twelve Data returns { status: 'error', code, message } on
            // quota / key problems even with 200 OK.
            throw new Error(
              `twelvedata /stocks ${exchange}: ${body.message ?? 'unknown error'} (code ${body.code ?? '?'})`,
            );
          }
          return body.data ?? [];
        }
      } catch (err) {
        if (err instanceof TwelveDataAuthError) throw err;
        lastErr = err;
      }
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error(`twelvedata /stocks ${exchange}: unknown error`);
  }
}

export class TwelveDataAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TwelveDataAuthError';
  }
}
