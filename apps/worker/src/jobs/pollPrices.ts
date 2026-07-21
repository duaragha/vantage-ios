/**
 * Poll latest prices for held tickers + the day-trade scanner universe, and emit
 * IntradayMove events (held tickers only).
 *
 * Source priority: Alpaca snapshot, Finnhub /quote, then yfinance for US
 * listings; yfinance directly for Canadian listings.
 *
 * Two scopes:
 *   - HELD US tickers get the full treatment: Alpaca snapshot (latest trade +
 *     today's open/high/low) with Finnhub's open as the IntradayMove % base
 *     → pctChange → MarketEvent kind=IntradayMove when |move| crosses the
 *     threshold (gated by market hours + a fresh, positive print). Today's OHLC
 *     is persisted.
 *   - SCANNER-UNIVERSE tickers (the liquidity-floor names the day-trade scanner
 *     can rank) get an Alpaca snapshot for US listings or a yfinance quote for
 *     Canadian listings, written to LivePrice only. They exist so the
 *     scanner can show a fresh price + today's move AND anchor trade-plan entries
 *     to today's intraday levels (break of today's high) instead of a multi-day
 *     DailyBar high. Held ∩ scanner names are polled once (held path, which now
 *     also captures the snapshot's OHLC so those names anchor to today's high too).
 *
 * Rate limit: Alpaca is 200/min; the scanner floor clears ~40-50 names today, so
 * held (~8) + scanner stays well under. Finnhub (60/min) is only hit for held
 * tickers. LivePrice is written for the union; IntradayMove logic is unchanged
 * and still held-only.
 *
 * Session coverage: the cron runs this per-minute across 04:00-20:00 ET on
 * weekdays (pre-market → after-hours), so the freshest LivePrice stays current
 * into the evening, not just during the regular session. The Alpaca snapshot's
 * latestTrade already reflects extended-hours IEX prints; we persist the trade's
 * own timestamp as fetchedAt so the scanner's session label is honest. The
 * IntradayMove EVENT path stays gated to regular hours (withinUsMarketHours) —
 * only the price WRITE spans pre/after-hours. CAVEAT: free Alpaca is the IEX
 * feed (one venue), so extended-hours coverage is partial — thin names can have
 * no pre/after-hours prints, in which case the last regular print carries over
 * (labeled "close", not a fake after-hours stamp). Full consolidated
 * extended-hours quotes require the paid SIP feed.
 *
 * Scanner names already clear the $5M average-dollar-volume floor. Held-name
 * alerts intentionally do not suppress a move just because the holding is
 * thin, but they do require a recent print and reject explicit zero size or
 * session volume so stale/empty quotes cannot create an event.
 */

import {
  prisma,
  getSettings,
  createMarketEvent,
  queueTelegramDelivery,
  EventKind,
  Prisma,
  type QueueTelegramDeliveryInput,
} from '@vantage/db';
import { exchangeFromSymbol, isCaExchange } from '@vantage/sources';
import { getAlpaca, getFinnhub, getYFinance } from '../lib/adapters.js';
import { buildPriceAlertDelivery, evaluatePriceAlerts } from '../lib/priceAlerts.js';
import { startOfEasternDay } from '../lib/marketTime.js';
import { hasFreshTradablePrint } from '../lib/intradayMovePolicy.js';
import type { FastifyBaseLogger } from 'fastify';

export interface PollPricesResult {
  tickersPolled: number;
  pricesChecked: number;
  movesDetected: number;
  /** LivePrice rows written for scanner-universe (non-held) tickers this run. */
  scannerPricesWritten: number;
  /** Threshold alerts persisted to the durable Telegram outbox this run. */
  priceAlertsSent: number;
  failedSources: string[];
  outsideMarketHours: boolean;
}

// Day-trade scanner universe selection — mirrors Step 1 of
// packages/core/src/goals/dayTradeScanner.ts (scanDayTradeCandidates) and the
// scope pollEodHistory already polls: TickerMetrics rows clearing the liquidity
// floor, capped, ordered by liquidity desc. Values are duplicated (module-
// private upstream) — keep in sync. The cap also bounds the Alpaca call count.
const SCANNER_MIN_DOLLAR_VOLUME = 5_000_000;
const SCANNER_UNIVERSE_CAP = 400;
const SCANNER_WRITE_BATCH_SIZE = 50;

interface PricePoint {
  ticker: string;
  last: number;
  open: number | null;
  size: number | null;
  dayVolume: number | null;
  source: string;
  timestamp: Date;
  // Today's intraday range (Alpaca snapshot). Persisted to LivePrice so the
  // day-trade scanner can anchor entries to today's high even for HELD names
  // (which take this path). Null when the snapshot had no daily bar yet.
  dayHigh: number | null;
  dayLow: number | null;
  dayOpen: number | null;
}

/** Return true if `now` falls within US market hours (9:30-16:00 ET, weekday). */
function withinUsMarketHours(now: Date = new Date()): boolean {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? '';
  if (['Sat', 'Sun'].includes(weekday)) return false;
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '-1');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '-1');
  if (Number.isNaN(hour) || Number.isNaN(minute)) return false;
  const minutesOfDay = hour * 60 + minute;
  // 9:30 = 570, 16:00 = 960
  return minutesOfDay >= 9 * 60 + 30 && minutesOfDay < 16 * 60;
}

async function fetchPrice(
  ticker: string,
  log: FastifyBaseLogger | Console,
  failed: Set<string>,
): Promise<PricePoint | null> {
  let last: number | null = null;
  let size: number | null = null;
  let dayVolume: number | null = null;
  let source = '';
  let timestamp: Date = new Date();
  let dayHigh: number | null = null;
  let dayLow: number | null = null;
  let dayOpen: number | null = null;
  const isCanadian = isCaExchange(exchangeFromSymbol(ticker));

  // Alpaca has no Canadian listing coverage. Route .TO/.NE/.V directly to
  // yfinance instead of logging a predictable Alpaca failure every minute.
  // For US listings, the snapshot returns latest trade + today's open/high/low
  // in one call at the same rate cost as the prior latest-trade. The OHLC lets the day-trade scanner
  // anchor entries to today's high for held names too.
  if (!isCanadian) {
    try {
      const alpaca = getAlpaca();
      const snap = await alpaca.getSnapshot(ticker);
      if (snap?.last != null) {
        last = snap.last;
        size = snap.lastTradeSize;
        source = 'alpaca';
        timestamp = snap.timestamp;
      }
      if (snap) {
        dayHigh = snap.dayHigh;
        dayLow = snap.dayLow;
        dayOpen = snap.dayOpen;
        dayVolume = snap.dayVolume;
      }
    } catch (err) {
      log.warn?.({ ticker, err: err instanceof Error ? err.message : err }, 'alpaca price failed');
      failed.add('alpaca');
    }
  }

  // Finnhub quote — the IntradayMove % base is its today's open (unchanged
  // semantics). Falls back to the Alpaca snapshot's open below.
  let open: number | null = null;
  if (!isCanadian) {
    try {
      const fn = getFinnhub();
      const q = await fn.getQuote(ticker);
      if (q) {
        if (q.o > 0) open = q.o;
        if (last === null && q.c > 0) {
          last = q.c;
          source = 'finnhub';
          if (q.t > 0) timestamp = new Date(q.t * 1000);
        }
      }
    } catch (err) {
      log.warn?.({ ticker, err: err instanceof Error ? err.message : err }, 'finnhub quote failed');
      failed.add('finnhub');
    }
  }

  // yfinance fallback
  if (last === null) {
    try {
      const yf = getYFinance();
      const q = await yf.getQuote(ticker);
      if (q?.last != null) {
        last = q.last;
        source = 'yfinance';
        timestamp = q.timestamp;
        if (q.dayOpen !== null && q.dayOpen > 0) open = q.dayOpen;
        dayOpen = q.dayOpen;
        dayHigh = q.dayHigh;
        dayLow = q.dayLow;
        dayVolume = q.dayVolume;
      }
    } catch (err) {
      log.warn?.(
        { ticker, err: err instanceof Error ? err.message : err },
        'yfinance quote failed',
      );
      failed.add('yfinance');
    }
  }

  // Open fallback: when Finnhub didn't return one, use the Alpaca snapshot's
  // today-open so a held name still gets an IntradayMove base + scanner open.
  if (open === null && dayOpen !== null) open = dayOpen;

  // A live price remains useful for valuation and stop/target checks even
  // when the source cannot provide today's open (common for Canadian Yahoo
  // fallback quotes). Only IntradayMove calculation needs the open.
  if (last === null) return null;
  return {
    ticker,
    last,
    open,
    size,
    source,
    timestamp,
    dayHigh,
    dayLow,
    dayOpen,
    dayVolume,
  };
}

/** Today's intraday levels written alongside the live price (scanner path). */
interface IntradayOhlc {
  dayOpen: number | null;
  dayHigh: number | null;
  dayLow: number | null;
}

const dec = (v: number | null | undefined): Prisma.Decimal | null =>
  v != null && Number.isFinite(v) ? new Prisma.Decimal(v) : null;

/**
 * Upsert one LivePrice row (one row per ticker; cheap, idempotent). When
 * `ohlc` is supplied (scanner snapshot path) today's open/high/low are
 * persisted too so the day-trade scanner can anchor entries to today's levels.
 * Omitting `ohlc` (held Finnhub/yfinance path) leaves those columns null on
 * create and clears them on update — a held-only row carries no intraday OHLC.
 *
 * `asOf` is the actual TRADE timestamp (the moment the price printed), persisted
 * as fetchedAt so the day-trade scanner labels the session honestly — a thin
 * name whose last IEX trade was 15:59 ET reads as "close", not a fake
 * "after-hours" stamped at the poll time. Falls back to now() when the source
 * gave no trade time (e.g. a daily-close-only snapshot). A small clock-skew
 * guard caps asOf at now() so a future timestamp can't make a row look fresher
 * than real time (which would defeat the staleness math).
 */
async function writeLivePrice(
  ticker: string,
  price: number,
  source: string,
  log: FastifyBaseLogger | Console,
  ohlc?: IntradayOhlc,
  asOf?: Date,
): Promise<boolean> {
  try {
    const intraday = {
      dayOpen: dec(ohlc?.dayOpen),
      dayHigh: dec(ohlc?.dayHigh),
      dayLow: dec(ohlc?.dayLow),
    };
    const now = new Date();
    const fetchedAt =
      asOf && Number.isFinite(asOf.getTime()) && asOf.getTime() <= now.getTime() ? asOf : now;
    await prisma.livePrice.upsert({
      where: { ticker },
      update: { price: new Prisma.Decimal(price), fetchedAt, source, ...intraday },
      create: { ticker, price: new Prisma.Decimal(price), fetchedAt, source, ...intraday },
    });
    return true;
  } catch (err) {
    log.warn?.(
      { ticker, err: err instanceof Error ? err.message : err },
      'livePrice upsert failed',
    );
    return false;
  }
}

/**
 * Scanner-universe tickers: the liquidity-floor names the day-trade scanner can
 * rank, ordered by liquidity desc and capped. Same selection as pollEodHistory.
 */
async function collectScannerTickers(): Promise<string[]> {
  const rows = await prisma.tickerMetrics.findMany({
    where: { avgDollarVolume30d: { gte: SCANNER_MIN_DOLLAR_VOLUME } },
    select: { ticker: true },
    orderBy: { avgDollarVolume30d: 'desc' },
    take: SCANNER_UNIVERSE_CAP,
  });
  return rows.map((r) => r.ticker.toUpperCase());
}

/**
 * Write Canadian scanner LivePrice rows from Yahoo's multi-symbol quote call.
 * Alpaca has no TSX/NEO/TSX-V coverage. Scanner rows never emit IntradayMove
 * events.
 */
async function pollCanadianScannerPrices(
  tickers: readonly string[],
  log: FastifyBaseLogger | Console,
  failed: Set<string>,
): Promise<number> {
  if (tickers.length === 0) return 0;
  try {
    const quotes = await getYFinance().getQuotes(tickers);
    if (quotes.size === 0) {
      failed.add('yfinance');
      log.warn?.({ tickerCount: tickers.length }, 'Yahoo scanner batch returned no quotes');
      return 0;
    }
    let written = 0;
    const rows = [...quotes.values()];
    for (let offset = 0; offset < rows.length; offset += SCANNER_WRITE_BATCH_SIZE) {
      const batch = rows.slice(offset, offset + SCANNER_WRITE_BATCH_SIZE);
      const results = await Promise.all(
        batch.map((quote) => {
          if (quote.last == null || !(quote.last > 0)) return Promise.resolve(false);
          return writeLivePrice(
            quote.ticker,
            quote.last,
            'yfinance',
            log,
            {
              dayOpen: quote.dayOpen,
              dayHigh: quote.dayHigh,
              dayLow: quote.dayLow,
            },
            quote.timestamp,
          );
        }),
      );
      written += results.filter(Boolean).length;
    }
    if (quotes.size < tickers.length) {
      log.warn?.(
        { requested: tickers.length, returned: quotes.size },
        'Yahoo scanner batch returned partial quotes',
      );
    }
    return written;
  } catch (err) {
    log.warn?.(
      { tickerCount: tickers.length, err: err instanceof Error ? err.message : err },
      'Yahoo scanner batch failed',
    );
    failed.add('yfinance');
    return 0;
  }
}

/**
 * Refresh scanner-only names. US snapshots come from Alpaca's multi-symbol
 * endpoint in bounded chunks; Canadian names use yfinance individually.
 */
async function pollScannerPrices(
  tickers: readonly string[],
  log: FastifyBaseLogger | Console,
  failed: Set<string>,
): Promise<number> {
  const canadian = tickers.filter((ticker) => isCaExchange(exchangeFromSymbol(ticker)));
  const us = tickers.filter((ticker) => !isCaExchange(exchangeFromSymbol(ticker)));
  let written = 0;

  if (us.length > 0) {
    try {
      const snapshots = await getAlpaca().getSnapshots(us);
      if (snapshots.size === 0) {
        failed.add('alpaca');
        log.warn?.({ tickerCount: us.length }, 'Alpaca scanner batch returned no snapshots');
      }
      const rows = [...snapshots.values()];
      for (let offset = 0; offset < rows.length; offset += SCANNER_WRITE_BATCH_SIZE) {
        const batch = rows.slice(offset, offset + SCANNER_WRITE_BATCH_SIZE);
        const results = await Promise.all(
          batch.map((snapshot) => {
            const price = snapshot.last ?? snapshot.dayClose;
            if (price == null || !(price > 0)) return Promise.resolve(false);
            const asOf = snapshot.last != null ? snapshot.timestamp : undefined;
            return writeLivePrice(
              snapshot.ticker,
              price,
              'alpaca',
              log,
              {
                dayOpen: snapshot.dayOpen,
                dayHigh: snapshot.dayHigh,
                dayLow: snapshot.dayLow,
              },
              asOf,
            );
          }),
        );
        written += results.filter(Boolean).length;
      }
    } catch (err) {
      log.warn?.(
        { tickerCount: us.length, err: err instanceof Error ? err.message : err },
        'Alpaca scanner batch failed',
      );
      failed.add('alpaca');
    }
  }

  written += await pollCanadianScannerPrices(canadian, log, failed);
  return written;
}

export async function pollPrices(
  log: FastifyBaseLogger | Console = console,
): Promise<PollPricesResult> {
  const settings = await getSettings();
  const threshold = settings?.intradayMoveThresholdPct ?? 5;

  const [positions, scannerTickers] = await Promise.all([
    prisma.position.findMany({
      where: { closedAt: null },
      include: { account: { select: { name: true } } },
    }),
    collectScannerTickers(),
  ]);
  const tickers = Array.from(new Set(positions.map((p) => p.ticker.toUpperCase())));
  const heldSet = new Set(tickers);
  const positionsByTicker = new Map<string, typeof positions>();
  for (const position of positions) {
    const key = position.ticker.toUpperCase();
    const rows = positionsByTicker.get(key) ?? [];
    rows.push(position);
    positionsByTicker.set(key, rows);
  }
  // Scanner names NOT already covered by the held path (held gets the richer
  // open + IntradayMove treatment; scanner-only gets a price written).
  const scannerOnly = scannerTickers.filter((t) => !heldSet.has(t));

  const pollStartedAt = new Date();
  const inMarket = withinUsMarketHours(pollStartedAt);
  const failed = new Set<string>();
  let pricesChecked = 0;
  let movesDetected = 0;
  let scannerPricesWritten = 0;
  let priceAlertsSent = 0;
  for (const ticker of tickers) {
    const point = await fetchPrice(ticker, log, failed);
    if (!point) continue;
    pricesChecked++;
    const pctChange = point.open === null ? null : ((point.last - point.open) / point.open) * 100;

    // Persist the live price so the web app's portfolio/compare/day-trade
    // loaders can surface intraday valuation. One row per ticker; upsert keeps
    // it cheap. We tag with the actual price source (alpaca/finnhub/yfinance) —
    // source is a free-text diagnostic field. Today's OHLC (from the Alpaca
    // snapshot) rides along so the scanner anchors entries to today's high for
    // held names too; null when the price came from a non-Alpaca fallback.
    // point.timestamp is the actual trade time → fetchedAt, so the scanner's
    // session label is honest (pre / regular / after-hours / close).
    await writeLivePrice(
      ticker,
      point.last,
      point.source,
      log,
      { dayOpen: point.dayOpen, dayHigh: point.dayHigh, dayLow: point.dayLow },
      point.timestamp,
    );

    for (const position of positionsByTicker.get(ticker) ?? []) {
      const decision = evaluatePriceAlerts({
        price: point.last,
        stopLoss: position.stopLoss === null ? null : Number(position.stopLoss),
        priceTarget: position.priceTarget === null ? null : Number(position.priceTarget),
        stopLossAlerted: position.stopLossAlertedAt !== null,
        priceTargetAlerted: position.priceTargetAlertedAt !== null,
      });
      const update: {
        stopLossAlertedAt?: Date | null;
        priceTargetAlertedAt?: Date | null;
      } = {};
      const deliveries: QueueTelegramDeliveryInput[] = [];
      const alertQueuedAt = new Date();
      if (decision.rearmStopLoss) update.stopLossAlertedAt = null;
      if (decision.rearmPriceTarget) update.priceTargetAlertedAt = null;

      if (decision.triggerStopLoss && position.stopLoss !== null) {
        deliveries.push(
          buildPriceAlertDelivery({
            kind: 'stop-loss',
            positionId: position.id,
            ticker,
            accountName: position.account.name,
            currency: position.currency,
            threshold: Number(position.stopLoss),
            price: point.last,
            observedAt: point.timestamp,
            queuedAt: alertQueuedAt,
          }),
        );
        update.stopLossAlertedAt = alertQueuedAt;
      }

      if (decision.triggerPriceTarget && position.priceTarget !== null) {
        deliveries.push(
          buildPriceAlertDelivery({
            kind: 'price-target',
            positionId: position.id,
            ticker,
            accountName: position.account.name,
            currency: position.currency,
            threshold: Number(position.priceTarget),
            price: point.last,
            observedAt: point.timestamp,
            queuedAt: alertQueuedAt,
          }),
        );
        update.priceTargetAlertedAt = alertQueuedAt;
      }

      if (Object.keys(update).length > 0) {
        await prisma.$transaction(async (tx) => {
          for (const delivery of deliveries) {
            await queueTelegramDelivery(delivery, tx);
          }
          await tx.position.update({ where: { id: position.id }, data: update });
        });
        priceAlertsSent += deliveries.length;
      }
    }

    if (!inMarket || pctChange === null) continue;
    if (Math.abs(pctChange) < threshold) continue;
    if (!hasFreshTradablePrint(point, pollStartedAt)) continue;

    // Dedup: only emit one IntradayMove per ticker per direction per day.
    // Without this, every one-minute poll cycle re-fires the event as long as
    // price stays past the threshold — flooding /insights and /calendar.
    const direction = pctChange >= 0 ? 'up' : 'down';
    const startOfToday = startOfEasternDay(point.timestamp);
    const existing = await prisma.marketEvent.findFirst({
      where: {
        kind: EventKind.IntradayMove,
        ticker,
        occurredAt: { gte: startOfToday },
      },
      select: { id: true, payload: true },
    });
    if (existing) {
      const prev = existing.payload as { pctChange?: number } | null;
      const prevDir = prev?.pctChange != null && prev.pctChange >= 0 ? 'up' : 'down';
      // Same direction → already alerted today, skip.
      if (prevDir === direction) continue;
      // Direction flipped (e.g. morning down 6%, afternoon up 6%) — treat
      // as a fresh event since that's a meaningful new signal.
    }

    await createMarketEvent({
      kind: EventKind.IntradayMove,
      ticker,
      occurredAt: point.timestamp,
      payload: {
        ticker,
        pctChange: Number(pctChange.toFixed(2)),
        price: point.last,
        open: point.open,
        source: point.source,
        dayVolume: point.dayVolume,
        thresholdPct: threshold,
      },
    });
    movesDetected++;
  }

  scannerPricesWritten = await pollScannerPrices(scannerOnly, log, failed);

  return {
    tickersPolled: tickers.length,
    pricesChecked,
    movesDetected,
    scannerPricesWritten,
    priceAlertsSent,
    failedSources: [...failed],
    outsideMarketHours: !inMarket,
  };
}
