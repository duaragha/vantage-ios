// Fetch a single ticker's live price via yfinance and upsert LivePrice.
// Used to backfill a freshly-added holding the cron hasn't reached yet.
const { prisma } = require('/repo/packages/db/dist/client.js');
const { Prisma } = require('/repo/node_modules/.pnpm/node_modules/@prisma/client');
const { YFinanceAdapter } = require('/repo/packages/sources/dist/yfinance.js');

const TICKER = process.argv[2];

(async () => {
  const yf = new YFinanceAdapter();
  const q = await yf.getQuote(TICKER);
  console.log(TICKER, 'quote:', JSON.stringify(q));
  const price = q && (q.last ?? q.price ?? q.regularMarketPrice ?? null);
  if (price) {
    await prisma.livePrice.upsert({
      where: { ticker: TICKER },
      update: { price: new Prisma.Decimal(price), fetchedAt: new Date(), source: 'yfinance' },
      create: { ticker: TICKER, price: new Prisma.Decimal(price), fetchedAt: new Date(), source: 'yfinance' },
    });
    console.log('wrote LivePrice', TICKER, price);
  } else {
    console.log('no price returned for', TICKER);
  }
  await prisma.$disconnect();
})();
