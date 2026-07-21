/**
 * Portfolio price lookup.
 *
 * The worker owns provider polling and persists one LivePrice row per ticker.
 * Dashboard reads therefore prefer a fresh persisted quote, then the latest
 * DailyBar close. Direct providers are only a cold-start fallback when neither
 * stored source exists.
 */

import { prisma } from '@vantage/db';
import { componentLogger } from '@vantage/notify';

export interface LivePrice {
  ticker: string;
  price: number;
  previousClose: number;
  changePct: number;
  fetchedAt: Date;
  source: string;
}

export interface StoredLivePriceInput {
  price: number;
  fetchedAt: Date;
  source: string;
}

export interface StoredDailyBarInput {
  close: number;
  date: Date;
}

const LIVE_PRICE_MAX_AGE_MS = 10 * 60_000;
const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const log = componentLogger('web/lib/prices');

function validPrice(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function easternDateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  return `${year ?? '0000'}-${month ?? '00'}-${day ?? '00'}`;
}

function barDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Pure selection logic, exported for regression tests. Bars must be newest first. */
export function resolveStoredPrice(
  ticker: string,
  live: StoredLivePriceInput | null,
  bars: readonly StoredDailyBarInput[],
  now: Date = new Date(),
): LivePrice | null {
  const usableBars = bars.filter((bar) => validPrice(bar.close));
  if (
    live &&
    validPrice(live.price) &&
    now.getTime() - live.fetchedAt.getTime() < LIVE_PRICE_MAX_AGE_MS
  ) {
    const latestBar = usableBars[0] ?? null;
    const previousBar =
      latestBar && barDateKey(latestBar.date) === easternDateKey(live.fetchedAt)
        ? (usableBars[1] ?? null)
        : latestBar;
    const previousClose = previousBar?.close ?? live.price;
    return {
      ticker,
      price: live.price,
      previousClose,
      changePct: previousClose > 0 ? ((live.price - previousClose) / previousClose) * 100 : 0,
      fetchedAt: live.fetchedAt,
      source: live.source,
    };
  }

  const latest = usableBars[0];
  if (!latest) return null;
  const previousClose = usableBars[1]?.close ?? latest.close;
  return {
    ticker,
    price: latest.close,
    previousClose,
    changePct: previousClose > 0 ? ((latest.close - previousClose) / previousClose) * 100 : 0,
    fetchedAt: latest.date,
    source: 'daily-bar',
  };
}

async function loadStoredPrices(tickers: readonly string[]): Promise<Record<string, LivePrice>> {
  const upper = Array.from(new Set(tickers.map((ticker) => ticker.toUpperCase())));
  if (upper.length === 0) return {};

  const [liveRows, barRows] = await Promise.all([
    prisma.livePrice.findMany({
      where: { ticker: { in: upper } },
      select: { ticker: true, price: true, fetchedAt: true, source: true },
    }),
    prisma.$queryRaw<Array<{ ticker: string; date: Date; close: unknown }>>`
      SELECT "ticker", "date", "close"
      FROM (
        SELECT
          "ticker",
          "date",
          "close",
          ROW_NUMBER() OVER (PARTITION BY "ticker" ORDER BY "date" DESC) AS row_num
        FROM "DailyBar"
        WHERE "ticker" = ANY(${upper})
      ) ranked
      WHERE row_num <= 2
      ORDER BY "ticker", "date" DESC
    `,
  ]);

  const liveByTicker = new Map(
    liveRows.map((row) => [
      row.ticker.toUpperCase(),
      { price: Number(row.price), fetchedAt: row.fetchedAt, source: row.source },
    ]),
  );
  const barsByTicker = new Map<string, StoredDailyBarInput[]>();
  for (const row of barRows) {
    const ticker = row.ticker.toUpperCase();
    const bucket = barsByTicker.get(ticker) ?? [];
    bucket.push({ close: Number(row.close), date: row.date });
    barsByTicker.set(ticker, bucket);
  }

  const out: Record<string, LivePrice> = {};
  const now = new Date();
  for (const ticker of upper) {
    const selected = resolveStoredPrice(
      ticker,
      liveByTicker.get(ticker) ?? null,
      barsByTicker.get(ticker) ?? [],
      now,
    );
    if (selected) out[ticker] = selected;
  }
  return out;
}

async function fetchFinnhubPrice(ticker: string): Promise<LivePrice | null> {
  const key = process.env['FINNHUB_API_KEY'];
  if (!key) return null;
  try {
    const response = await fetch(
      `${FINNHUB_BASE}/quote?symbol=${encodeURIComponent(ticker)}&token=${key}`,
      { cache: 'no-store' },
    );
    if (!response.ok) {
      log.warn({ ticker, status: response.status }, 'Finnhub cold-start quote rejected');
      return null;
    }
    const body = (await response.json()) as { c?: number; pc?: number; dp?: number; t?: number };
    if (!body.c || !validPrice(body.c)) return null;
    const previousClose = body.pc && validPrice(body.pc) ? body.pc : body.c;
    return {
      ticker,
      price: body.c,
      previousClose,
      changePct:
        body.dp !== undefined && Number.isFinite(body.dp)
          ? body.dp
          : ((body.c - previousClose) / previousClose) * 100,
      fetchedAt: body.t ? new Date(body.t * 1000) : new Date(),
      source: 'finnhub',
    };
  } catch (err) {
    log.warn({ ticker, err }, 'Finnhub cold-start quote failed');
    return null;
  }
}

async function fetchYFinancePrice(ticker: string): Promise<LivePrice | null> {
  try {
    const { YFinanceAdapter } = await import('@vantage/sources');
    const quote = await new YFinanceAdapter().getQuote(ticker);
    if (quote?.last == null || !validPrice(quote.last)) return null;
    return {
      ticker,
      price: quote.last,
      previousClose: quote.last,
      changePct: 0,
      fetchedAt: quote.timestamp,
      source: 'yfinance',
    };
  } catch (err) {
    log.warn({ ticker, err }, 'yfinance cold-start quote failed');
    return null;
  }
}

async function fetchProviderPrice(ticker: string): Promise<LivePrice | null> {
  const isCanadian = /\.(?:TO|NE|V)$/.test(ticker);
  if (!isCanadian) {
    const finnhub = await fetchFinnhubPrice(ticker);
    if (finnhub) return finnhub;
  }
  return fetchYFinancePrice(ticker);
}

export async function fetchLivePrice(ticker: string): Promise<LivePrice | null> {
  const upper = ticker.toUpperCase();
  const prices = await fetchLivePrices([upper]);
  return prices[upper] ?? null;
}

export async function fetchLivePrices(tickers: string[]): Promise<Record<string, LivePrice>> {
  const upper = Array.from(new Set(tickers.map((ticker) => ticker.toUpperCase())));
  if (upper.length === 0) return {};

  let out: Record<string, LivePrice> = {};
  try {
    out = await loadStoredPrices(upper);
  } catch (err) {
    log.warn({ err }, 'stored price lookup failed; falling back to providers');
  }

  const missing = upper.filter((ticker) => !out[ticker]);
  if (missing.length === 0) return out;
  const fallback = await Promise.all(
    missing.map(async (ticker) => [ticker, await fetchProviderPrice(ticker)] as const),
  );
  for (const [ticker, price] of fallback) {
    if (price) out[ticker] = price;
  }
  return out;
}
