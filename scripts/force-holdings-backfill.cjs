// One-shot: force-pull 540 days of DailyBar for the 5 held tickers.
// Tiingo rate-limited them during the normal pollEodHistory run, so we
// upsert directly here with sleep-between-tickers to dodge the limit.
const { prisma } = require('/repo/packages/db/dist/client.js');
const { getTiingo } = require('/repo/apps/worker/dist/lib/adapters.js');
const { Prisma } = require('/repo/node_modules/.pnpm/node_modules/@prisma/client');

const TICKERS = ['RKLB', 'NBIS', 'INFQ', 'LUNR', 'RGTI'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const tiingo = getTiingo();
  const start = new Date(Date.now() - 540 * 24 * 3600 * 1000);
  const end = new Date();
  for (const t of TICKERS) {
    try {
      const bars = await tiingo.getDailyPrices(t, start, end);
      let written = 0;
      for (const b of bars) {
        await prisma.dailyBar.upsert({
          where: { ticker_date: { ticker: t, date: b.date } },
          update: {
            open: new Prisma.Decimal(b.open),
            high: new Prisma.Decimal(b.high),
            low: new Prisma.Decimal(b.low),
            close: new Prisma.Decimal(b.close),
            volume: BigInt(b.volume ?? 0),
            source: 'tiingo',
          },
          create: {
            ticker: t,
            date: b.date,
            open: new Prisma.Decimal(b.open),
            high: new Prisma.Decimal(b.high),
            low: new Prisma.Decimal(b.low),
            close: new Prisma.Decimal(b.close),
            volume: BigInt(b.volume ?? 0),
            source: 'tiingo',
          },
        });
        written++;
      }
      console.log(t, 'wrote', written, 'bars');
    } catch (e) {
      console.log(t, 'ERROR:', (e.message ?? String(e)).slice(0, 200));
    }
    await sleep(3000); // dodge Tiingo per-second rate limit
  }
  await prisma.$disconnect();
})();
