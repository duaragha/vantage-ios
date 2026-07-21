import type { FastifyBaseLogger } from 'fastify';
import { Prisma, prisma } from '@vantage/db';
import { detectLotteryFromBars } from '@vantage/core';

interface LotteryBarRow {
  ticker: string;
  date: Date;
  close: Prisma.Decimal;
}

export interface UpdateLotteryFlagsOptions {
  tickers?: string[];
}

export interface UpdateLotteryFlagsResult {
  barsRead: number;
  tickersEvaluated: number;
  insufficientHistory: number;
  flagsChanged: number;
  lotteryCount: number;
}

export async function updateLotteryFlags(
  log: FastifyBaseLogger | Console = console,
  options: UpdateLotteryFlagsOptions = {},
): Promise<UpdateLotteryFlagsResult> {
  const tickers = Array.from(
    new Set(
      (options.tickers ?? [])
        .map((ticker) => ticker.trim().toUpperCase())
        .filter((ticker) => /^[A-Z0-9.-]{1,12}$/.test(ticker)),
    ),
  );
  const filter =
    tickers.length > 0 ? Prisma.sql`WHERE "ticker" IN (${Prisma.join(tickers)})` : Prisma.empty;
  const rows = await prisma.$queryRaw<LotteryBarRow[]>(Prisma.sql`
    WITH ranked AS (
      SELECT
        "ticker",
        "date",
        "close",
        ROW_NUMBER() OVER (PARTITION BY "ticker" ORDER BY "date" DESC) AS row_num
      FROM "DailyBar"
      ${filter}
    )
    SELECT "ticker", "date", "close"
    FROM ranked
    WHERE row_num <= 20
    ORDER BY "ticker", "date" ASC
  `);

  const grouped = new Map<string, LotteryBarRow[]>();
  for (const row of rows) {
    const ticker = row.ticker.toUpperCase();
    const bucket = grouped.get(ticker) ?? [];
    bucket.push(row);
    grouped.set(ticker, bucket);
  }

  const decisions = new Map<string, boolean>();
  let insufficientHistory = 0;
  for (const [ticker, bars] of grouped) {
    const detected = detectLotteryFromBars({
      bars: bars.map((bar) => ({ date: bar.date, close: Number(bar.close) })),
    });
    if (!detected) {
      insufficientHistory++;
      continue;
    }
    decisions.set(ticker, detected.shouldFlag);
  }

  const symbols = [...decisions.keys()];
  const current = new Map<string, boolean>();
  for (let offset = 0; offset < symbols.length; offset += 1000) {
    const batch = symbols.slice(offset, offset + 1000);
    const universeRows = await prisma.tickerUniverse.findMany({
      where: { symbol: { in: batch } },
      select: { symbol: true, isLottery: true },
    });
    for (const row of universeRows) current.set(row.symbol.toUpperCase(), row.isLottery);
  }

  const changed = symbols.filter(
    (symbol) => current.has(symbol) && current.get(symbol) !== decisions.get(symbol),
  );
  for (let offset = 0; offset < changed.length; offset += 100) {
    const batch = changed.slice(offset, offset + 100);
    await prisma.$transaction(
      batch.map((symbol) =>
        prisma.tickerUniverse.update({
          where: { symbol },
          data: { isLottery: decisions.get(symbol) ?? false },
        }),
      ),
    );
  }

  const result: UpdateLotteryFlagsResult = {
    barsRead: rows.length,
    tickersEvaluated: decisions.size,
    insufficientHistory,
    flagsChanged: changed.length,
    lotteryCount: [...decisions.values()].filter(Boolean).length,
  };
  log.info?.(result, 'lottery quality flags updated');
  return result;
}
