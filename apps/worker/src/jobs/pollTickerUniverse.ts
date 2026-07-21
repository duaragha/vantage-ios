/**
 * Weekly ticker-universe refresh.
 *
 * POST /jobs/poll/tickerUniverse, cron `0 6 * * 0` (Sunday 6am local).
 *
 * Sourcing (new strategy, replaces the old per-ticker Finnhub profile loop):
 *
 *   US           → Tiingo supported_tickers.zip (1 static download, ~127k
 *                  rows). Filtered in-adapter to active common stock. Each
 *                  row's `exchange` becomes the TickerUniverse.exchange
 *                  (NASDAQ, NYSE, AMEX, ...).
 *   TO / NE / V  → Twelve Data /stocks?exchange=TSX|NEO|TSXV (1 JSON call
 *                  per exchange, no API key required). Filtered to type =
 *                  "Common Stock". Symbols are suffixed with .TO / .NE / .V
 *                  to match our internal convention; symbolRaw keeps the
 *                  bare form for cashtag matching.
 *
 * Market cap + sector are left NULL on the bulk seed — Finnhub profile
 * backfill runs separately (and can optionally chain off this job via
 * `opts.backfillProfiles === true`, capped at 30/min and 500 symbols to stay
 * under Finnhub's undocumented throttle).
 *
 * Dev escape hatch: `opts.limit` caps the work to N symbols per exchange so
 * a smoke run completes in seconds.
 */

import type { FastifyBaseLogger } from 'fastify';
import { prisma, countAll, upsertBulk, buildAliases, type UpsertTickerInput } from '@vantage/db';
import {
  deriveCurrency,
  getTickerCikMap,
  type ExchangeCode,
  type TwelveDataExchange,
} from '@vantage/sources';
import { getTiingo, getTwelveData } from '../lib/adapters.js';
import { backfillProfiles as runBackfillProfiles } from './backfillProfiles.js';

export type ExchangeOption = ExchangeCode;

/**
 * Map our internal Canadian exchange codes ↔ Twelve Data's names.
 *   TO (Toronto Stock Exchange)     → TSX
 *   NE (Cboe Canada / NEO)          → NEO
 *   V  (TSX Venture)                → TSXV
 */
const CA_TD_EXCHANGE: Record<Exclude<ExchangeCode, 'US'>, TwelveDataExchange> = {
  TO: 'TSX',
  NE: 'NEO',
  V: 'TSXV',
};

const CA_SUFFIX: Record<Exclude<ExchangeCode, 'US'>, string> = {
  TO: '.TO',
  NE: '.NE',
  V: '.V',
};

/** Backfill cap: max profile calls chained from a universe refresh. */
const BACKFILL_MAX_SYMBOLS = 500;

export interface PollTickerUniverseOptions {
  /**
   * Cap the number of symbols processed per exchange per run. Useful for
   * dev iteration / smoke tests. Omit for production.
   */
  limit?: number;
  /**
   * Exchanges to refresh. Defaults to ['US', 'TO', 'NE'] — the set Raghav
   * actually cares about. Add 'V' for TSX Venture once there's demand.
   */
  exchanges?: ReadonlyArray<ExchangeOption>;
  /**
   * If true, after the bulk seed, iterate rows with NULL marketCapUsd and
   * call Finnhub /stock/profile2 at a capped rate. Stops early on a 429 or
   * once `BACKFILL_MAX_SYMBOLS` have been processed.
   */
  backfillProfiles?: boolean;
}

export interface PollTickerUniverseResult {
  exchangesProcessed: ReadonlyArray<ExchangeOption>;
  tickersFromTiingo: number;
  tickersFromTwelveData: number;
  newRows: number;
  updatedRows: number;
  profileBackfilled: number;
  /** US symbols matched to the current SEC company_tickers.json map. */
  ciksMapped: number;
  runtimeMs: number;
  /** Per-exchange breakdown for the ops page. */
  perExchange: Array<{
    exchange: ExchangeOption;
    fetched: number;
    upserted: number;
    source: 'tiingo' | 'twelvedata';
    reason?: string;
  }>;
  /** Total rows in TickerUniverse after the run (sanity check). */
  universeSizeAfter: number;
}

export function universeRefreshFailure(
  rows: PollTickerUniverseResult['perExchange'],
): string | null {
  const failed = rows.filter((row) => row.reason || row.fetched === 0);
  if (failed.length === 0) return null;
  return `ticker universe refresh incomplete: ${failed
    .map((row) => `${row.exchange} (${row.reason ?? 'zero symbols returned'})`)
    .join(', ')}`;
}

export async function pollTickerUniverse(
  log: FastifyBaseLogger | Console = console,
  opts: PollTickerUniverseOptions = {},
): Promise<PollTickerUniverseResult> {
  const started = Date.now();
  const exchanges: ReadonlyArray<ExchangeOption> =
    opts.exchanges && opts.exchanges.length > 0 ? opts.exchanges : ['US', 'TO', 'NE'];

  log.info?.(
    { event: 'poll.tickerUniverse.start', exchanges, opts },
    'ticker universe refresh starting',
  );

  const sizeBefore = await countAll();

  const perExchange: PollTickerUniverseResult['perExchange'] = [];
  let tickersFromTiingo = 0;
  let tickersFromTwelveData = 0;
  let totalUpserted = 0;
  let ciksMapped = 0;

  // US must run first if present so TSX CDR detection has the US symbol set
  // to compare against. Preserve the caller's other ordering decisions.
  const usSymbolsForCdr = new Set<string>();
  const orderedExchanges = [
    ...exchanges.filter((e) => e === 'US'),
    ...exchanges.filter((e) => e !== 'US'),
  ];

  for (const exchange of orderedExchanges) {
    try {
      if (exchange === 'US') {
        const res = await seedUs(log, opts);
        tickersFromTiingo += res.fetched;
        totalUpserted += res.upserted;
        ciksMapped += res.ciksMapped;
        for (const s of res.usSymbolBareSet) usSymbolsForCdr.add(s);
        perExchange.push({
          exchange,
          fetched: res.fetched,
          upserted: res.upserted,
          source: 'tiingo',
        });
      } else {
        const res = await seedCanadian(exchange, log, opts, usSymbolsForCdr);
        tickersFromTwelveData += res.fetched;
        totalUpserted += res.upserted;
        perExchange.push({
          exchange,
          fetched: res.fetched,
          upserted: res.upserted,
          source: 'twelvedata',
          ...(res.reason ? { reason: res.reason } : {}),
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn?.({ exchange, err: msg }, 'ticker universe: exchange refresh threw');
      perExchange.push({
        exchange,
        fetched: 0,
        upserted: 0,
        source: exchange === 'US' ? 'tiingo' : 'twelvedata',
        reason: msg,
      });
    }
  }

  const sizeAfter = await countAll();
  const newRows = Math.max(0, sizeAfter - sizeBefore);
  const updatedRows = Math.max(0, totalUpserted - newRows);

  let profileBackfilled = 0;
  if (opts.backfillProfiles) {
    const profileResult = await runBackfillProfiles(log, {
      limit: BACKFILL_MAX_SYMBOLS,
    });
    profileBackfilled = profileResult.universeUpserted;
  }

  const result: PollTickerUniverseResult = {
    exchangesProcessed: exchanges,
    tickersFromTiingo,
    tickersFromTwelveData,
    newRows,
    updatedRows,
    profileBackfilled,
    ciksMapped,
    runtimeMs: Date.now() - started,
    perExchange,
    universeSizeAfter: sizeAfter,
  };
  log.info?.(result, 'poll.tickerUniverse: done');
  const failure = universeRefreshFailure(perExchange);
  if (failure) throw new Error(failure);
  return result;
}

// ---------------------------------------------------------------------------
// US refresh — Tiingo supported_tickers.zip
// ---------------------------------------------------------------------------

async function seedUs(
  log: FastifyBaseLogger | Console,
  opts: PollTickerUniverseOptions,
): Promise<{
  fetched: number;
  upserted: number;
  ciksMapped: number;
  usSymbolBareSet: Set<string>;
}> {
  const tiingo = getTiingo();
  const rows = await tiingo.downloadSupportedTickers({
    activeCommonStockOnly: true,
  });
  log.info?.(
    { fetched: rows.length, source: 'tiingo', exchange: 'US' },
    'ticker universe: downloaded Tiingo supported_tickers',
  );

  // The Tiingo file includes non-US venues (ASX, LSE, SHE, SHG, BATS) — we
  // only want the US venues the app trades in USD.
  const US_EXCHANGES = new Set(['NASDAQ', 'NYSE', 'AMEX', 'NYSE ARCA', 'NYSE MKT', 'BATS']);
  const usRows = rows.filter((r) => US_EXCHANGES.has(r.exchange) && r.priceCurrency === 'USD');
  if (usRows.length === 0) {
    throw new Error('Tiingo returned zero active US common stocks');
  }

  const working = opts.limit ? usRows.slice(0, opts.limit) : usRows;
  let tickerCikMap: Record<string, number> = {};
  try {
    tickerCikMap = await getTickerCikMap();
    log.info?.(
      { mapped: Object.keys(tickerCikMap).length },
      'ticker universe: refreshed SEC company_tickers map',
    );
  } catch (err) {
    log.warn?.(
      { err: err instanceof Error ? err.message : err },
      'ticker universe: SEC CIK map refresh failed',
    );
  }
  const existingNames = await prisma.tickerUniverse.findMany({
    where: { symbol: { in: working.map((row) => row.ticker) } },
    select: { symbol: true, name: true },
  });
  const nameBySymbol = new Map(existingNames.map((row) => [row.symbol, row.name]));

  const records: UpsertTickerInput[] = working.map((r) => {
    const symbol = r.ticker; // already uppercased in the adapter
    const cik = tickerCikMap[symbol];
    return {
      symbol,
      // Tiingo has no company-name field. Preserve an enriched name when the
      // row exists and use the symbol only for a brand-new row.
      name: nameBySymbol.get(symbol) ?? symbol,
      exchange: r.exchange,
      currency: 'USD',
      symbolRaw: symbol,
      ...(typeof cik === 'number' && cik > 0 ? { cik: String(cik) } : {}),
      // Market cap, sector, and aliases are absent from this feed. Omitting
      // them preserves values populated by profile and fundamentals jobs.
    };
  });

  log.info?.({ toUpsert: records.length, exchange: 'US' }, 'ticker universe: upserting US batch');
  const { upsertedCount } = await upsertBulk(records);

  const bare = new Set<string>(records.map((r) => r.symbol));
  const ciksMapped = records.filter((record) => record.cik !== null).length;
  return {
    fetched: usRows.length,
    upserted: upsertedCount,
    ciksMapped,
    usSymbolBareSet: bare,
  };
}

// ---------------------------------------------------------------------------
// Canadian refresh — Twelve Data /stocks
// ---------------------------------------------------------------------------

async function seedCanadian(
  exchange: Exclude<ExchangeCode, 'US'>,
  log: FastifyBaseLogger | Console,
  opts: PollTickerUniverseOptions,
  knownUsSymbols: Set<string>,
): Promise<{ fetched: number; upserted: number; reason?: string }> {
  const td = getTwelveData();
  const tdExchange = CA_TD_EXCHANGE[exchange];
  const rows = await td.getStocksByExchange(tdExchange, {
    commonStockOnly: true,
    ...(exchange === 'TO' ? { knownUsSymbols } : {}),
  });
  if (rows.length === 0) {
    throw new Error(`Twelve Data returned zero ${tdExchange} common stocks`);
  }
  log.info?.(
    { fetched: rows.length, source: 'twelvedata', exchange, tdExchange },
    'ticker universe: fetched Twelve Data listings',
  );

  const suffix = CA_SUFFIX[exchange];
  const working = opts.limit ? rows.slice(0, opts.limit) : rows;

  const records: UpsertTickerInput[] = working.map((r) => {
    const bare = r.symbol.toUpperCase();
    // Twelve Data returns bare symbols like "SHOP" — suffix them to match
    // the internal convention used by priceOracle + ticker-extract.
    const suffixed = bare.endsWith(suffix) ? bare : `${bare}${suffix}`;
    const baseAliases = buildAliases(r.name);
    // Stash the CDR flag in aliases? No — better to leave that for a future
    // schema bump. For now just skip tagging persistently; it's only needed
    // at seed time to avoid rethinking the thesis for a CDR.
    return {
      symbol: suffixed,
      name: r.name,
      exchange,
      currency: deriveCurrency(exchange),
      symbolRaw: bare,
      sector: null,
      marketCapUsd: null,
      aliases: baseAliases,
    };
  });

  log.info?.({ toUpsert: records.length, exchange }, 'ticker universe: upserting CA batch');
  const { upsertedCount } = await upsertBulk(records);
  return { fetched: rows.length, upserted: upsertedCount };
}
