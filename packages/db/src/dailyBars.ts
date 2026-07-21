/**
 * DailyBar CRUD helpers.
 *
 * Persisted daily OHLCV bars from Alpaca (US), Yahoo Finance (Canada), and a
 * bounded Tiingo fallback. Written by pollEodHistory; read by:
 *   - /compare's multi-window return and range columns
 *   - stored-price fallbacks when a live quote is unavailable
 *   - the backtest engine's fast path (cache-then-fetch)
 *   - packages/core/src/discover/rotation.ts `loadMomentum`
 *
 * Dates are stored as `@db.Date` (calendar date, no time) so callers can
 * compare by day without worrying about UTC drift.
 */

import { Prisma, type DailyBar } from '@prisma/client';
import { prisma } from './client.js';

export interface UpsertDailyBarInput {
  ticker: string;
  date: Date;
  open: Prisma.Decimal | number | string;
  high: Prisma.Decimal | number | string;
  low: Prisma.Decimal | number | string;
  close: Prisma.Decimal | number | string;
  volume?: Prisma.Decimal | number | string | bigint;
  source?: string;
}

export interface UpsertBarsResult {
  written: number;
}

const UPSERT_CHUNK_SIZE = 500;

/**
 * Normalize a provider Date to its UTC calendar day so the unique
 * (ticker, date) constraint de-dupes cleanly across sources and reruns.
 */
function toUtcDate(d: Date): Date {
  const out = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  return out;
}

function toBigInt(v: Prisma.Decimal | number | string | bigint | undefined): bigint {
  if (v === undefined || v === null) return 0n;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return 0n;
    return BigInt(Math.trunc(v));
  }
  if (typeof v === 'string') {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0n;
    return BigInt(Math.trunc(n));
  }
  // Prisma.Decimal
  try {
    const n = Number(v.toString());
    if (!Number.isFinite(n)) return 0n;
    return BigInt(Math.trunc(n));
  } catch {
    return 0n;
  }
}

/**
 * Batched upsert on (ticker, date). Returns the total count of rows written
 * (created or updated). Input rows are deduped by (ticker, UTC-date) before
 * the write because provider windows can overlap on retries.
 */
export async function upsertBars(rows: readonly UpsertDailyBarInput[]): Promise<UpsertBarsResult> {
  if (rows.length === 0) return { written: 0 };

  // Dedup on (ticker, iso-date). Last write wins.
  const deduped = new Map<string, UpsertDailyBarInput & { _date: Date }>();
  for (const r of rows) {
    const ticker = r.ticker.toUpperCase();
    const date = toUtcDate(r.date);
    const key = `${ticker}|${date.toISOString().slice(0, 10)}`;
    deduped.set(key, { ...r, ticker, _date: date });
  }

  // Prisma has no native bulk upsert for a composite key. A raw parameterized
  // INSERT keeps a first-run history backfill to one statement per 500 bars
  // instead of hundreds of individual Prisma upserts. All values remain bound
  // parameters, and ON CONFLICT preserves the previous last-write-wins contract.
  const prepared = Array.from(deduped.values());
  const fetchedAt = new Date();
  const statements: Array<Prisma.PrismaPromise<number>> = [];

  for (let offset = 0; offset < prepared.length; offset += UPSERT_CHUNK_SIZE) {
    const chunk = prepared.slice(offset, offset + UPSERT_CHUNK_SIZE);
    const values = chunk.map(
      (r) => Prisma.sql`(
      ${r.ticker},
      ${r._date},
      ${r.open},
      ${r.high},
      ${r.low},
      ${r.close},
      ${toBigInt(r.volume)},
      ${r.source ?? 'unknown'},
      ${fetchedAt}
    )`,
    );

    statements.push(
      prisma.$executeRaw(Prisma.sql`
        INSERT INTO "DailyBar"
          ("ticker", "date", "open", "high", "low", "close", "volume", "source", "fetchedAt")
        VALUES ${Prisma.join(values)}
        ON CONFLICT ("ticker", "date") DO UPDATE SET
          "open" = EXCLUDED."open",
          "high" = EXCLUDED."high",
          "low" = EXCLUDED."low",
          "close" = EXCLUDED."close",
          "volume" = EXCLUDED."volume",
          "source" = EXCLUDED."source",
          "fetchedAt" = EXCLUDED."fetchedAt"
      `),
    );
  }

  await prisma.$transaction(statements);
  return { written: prepared.length };
}

/** Most-recent bar by date for a single ticker. */
export function getLatestBar(ticker: string): Promise<DailyBar | null> {
  return prisma.dailyBar.findFirst({
    where: { ticker: ticker.toUpperCase() },
    orderBy: { date: 'desc' },
  });
}

/** All bars for a ticker in [start, end], ascending by date. */
export function getBarsInRange(ticker: string, start: Date, end: Date): Promise<DailyBar[]> {
  return prisma.dailyBar.findMany({
    where: {
      ticker: ticker.toUpperCase(),
      date: { gte: toUtcDate(start), lte: toUtcDate(end) },
    },
    orderBy: { date: 'asc' },
  });
}

/**
 * Nth-most-recent bar for a ticker (1-indexed). `nBack=1` returns the same
 * row as `getLatestBar`; `nBack=20` returns the bar 20 trading days back —
 * used for the 20d return on /compare.
 *
 * Returns null when fewer than `nBack` bars exist for the ticker.
 */
export async function getNthLatestBar(ticker: string, nBack: number): Promise<DailyBar | null> {
  if (nBack < 1 || !Number.isInteger(nBack)) return null;
  const rows = await prisma.dailyBar.findMany({
    where: { ticker: ticker.toUpperCase() },
    orderBy: { date: 'desc' },
    take: 1,
    skip: nBack - 1,
  });
  return rows[0] ?? null;
}

/**
 * Latest bar per ticker for a batch of tickers. Returns a Map keyed by
 * UPPERCASE ticker. Tickers with no bars are omitted.
 *
 * Uses a raw SQL DISTINCT-ON to avoid N+1 (one query, not one-per-ticker).
 */
export async function getLatestBarsForTickers(
  tickers: readonly string[],
): Promise<Map<string, DailyBar>> {
  const out = new Map<string, DailyBar>();
  if (tickers.length === 0) return out;
  const upper = Array.from(new Set(tickers.map((t) => t.toUpperCase())));

  const rows = await prisma.$queryRaw<
    Array<{
      id: number;
      ticker: string;
      date: Date;
      open: Prisma.Decimal;
      high: Prisma.Decimal;
      low: Prisma.Decimal;
      close: Prisma.Decimal;
      volume: bigint;
      source: string;
      fetchedAt: Date;
    }>
  >`
    SELECT DISTINCT ON ("ticker")
      "id", "ticker", "date", "open", "high", "low", "close",
      "volume", "source", "fetchedAt"
    FROM "DailyBar"
    WHERE "ticker" = ANY(${upper})
    ORDER BY "ticker", "date" DESC
  `;

  for (const r of rows) {
    out.set(r.ticker.toUpperCase(), r as unknown as DailyBar);
  }
  return out;
}
