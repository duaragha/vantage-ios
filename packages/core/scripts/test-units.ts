/**
 * Phase 17 unit tests for catalyst-engine foundations.
 *
 * Covers:
 *   - detectClusters (insider cluster detector)
 *   - detectUpgrade  (analyst upgrade detector)
 *   - qualityFilter  (shared quality gates)
 *   - detectLotteryFromBars (lottery auto-detect)
 *
 * Plain tsx script following the existing test-units pattern in
 * packages/llm and packages/sources. Run via:
 *   pnpm tsx packages/core/scripts/test-units.ts
 */

import { strict as assert } from 'node:assert';
import {
  detectClusters,
  detectUpgrade,
  consensusFromRow,
  qualityFilter,
  detectLotteryFromBars,
  type ClusterEvent,
} from '../src/index.js';
import type {
  AnalystRecommendation,
  InsiderTransaction,
  TickerUniverse,
} from '@vantage/db';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL  ${name}`);
    console.error(`    ${e instanceof Error ? e.message : String(e)}`);
    failed++;
  }
}

function makeTxn(
  override: Partial<InsiderTransaction> &
    Pick<InsiderTransaction, 'ticker' | 'insiderName'>,
): InsiderTransaction {
  const now = override.transactionDate ?? new Date('2026-04-25T00:00:00Z');
  const shares = override.shares ?? (1000 as unknown as InsiderTransaction['shares']);
  const price = override.pricePerShare ?? (50 as unknown as InsiderTransaction['pricePerShare']);
  // ts-friendly: cast plain numbers to Decimal-like for the test fixtures
  return {
    id: 0,
    ticker: override.ticker,
    insiderName: override.insiderName,
    insiderTitle: override.insiderTitle ?? null,
    transactionDate: now,
    transactionCode: override.transactionCode ?? 'P',
    shares,
    pricePerShare: price,
    valueUsd: (override.valueUsd ?? Number(shares) * Number(price)) as unknown as InsiderTransaction['valueUsd'],
    filingDate: override.filingDate ?? now,
    source: override.source ?? 'finnhub',
    createdAt: override.createdAt ?? now,
  } as InsiderTransaction;
}

console.log('\n--- detectClusters ---');

await test('single buy below LOW threshold returns no cluster', () => {
  const txns = [
    makeTxn({
      ticker: 'AAPL',
      insiderName: 'Tim Cook',
      shares: 100 as unknown as InsiderTransaction['shares'],
      pricePerShare: 100 as unknown as InsiderTransaction['pricePerShare'],
      valueUsd: 10_000 as unknown as InsiderTransaction['valueUsd'],
    }),
  ];
  const events = detectClusters(txns, { sinceHours: 168 });
  assert.equal(events.length, 0);
});

await test('three insiders + $5M total → HIGH conviction', () => {
  const ticker = 'NVDA';
  const txns = [
    makeTxn({
      ticker,
      insiderName: 'CEO Jensen',
      insiderTitle: 'Chief Executive Officer',
      shares: 10_000 as unknown as InsiderTransaction['shares'],
      pricePerShare: 200 as unknown as InsiderTransaction['pricePerShare'],
      valueUsd: 2_000_000 as unknown as InsiderTransaction['valueUsd'],
    }),
    makeTxn({
      ticker,
      insiderName: 'CFO Colette',
      insiderTitle: 'Chief Financial Officer',
      shares: 8_000 as unknown as InsiderTransaction['shares'],
      pricePerShare: 200 as unknown as InsiderTransaction['pricePerShare'],
      valueUsd: 1_600_000 as unknown as InsiderTransaction['valueUsd'],
    }),
    makeTxn({
      ticker,
      insiderName: 'Chair Dawn',
      insiderTitle: 'Chairwoman of the Board',
      shares: 7_500 as unknown as InsiderTransaction['shares'],
      pricePerShare: 200 as unknown as InsiderTransaction['pricePerShare'],
      valueUsd: 1_500_000 as unknown as InsiderTransaction['valueUsd'],
    }),
  ];
  const events = detectClusters(txns, { sinceHours: 168 });
  assert.equal(events.length, 1);
  const ev = events[0] as ClusterEvent;
  assert.equal(ev.ticker, 'NVDA');
  assert.equal(ev.distinctInsiders, 3);
  assert.equal(ev.conviction, 'HIGH');
  assert.equal(ev.directorCount >= 1, true);
  assert.ok(ev.totalUsd >= 5_000_000 - 1);
});

await test('three insiders split across tickers → no cluster either way', () => {
  const txns = [
    makeTxn({
      ticker: 'AAPL',
      insiderName: 'A',
      shares: 1000 as unknown as InsiderTransaction['shares'],
      pricePerShare: 50 as unknown as InsiderTransaction['pricePerShare'],
      valueUsd: 50_000 as unknown as InsiderTransaction['valueUsd'],
    }),
    makeTxn({
      ticker: 'MSFT',
      insiderName: 'B',
      shares: 1000 as unknown as InsiderTransaction['shares'],
      pricePerShare: 50 as unknown as InsiderTransaction['pricePerShare'],
      valueUsd: 50_000 as unknown as InsiderTransaction['valueUsd'],
    }),
    makeTxn({
      ticker: 'GOOG',
      insiderName: 'C',
      shares: 1000 as unknown as InsiderTransaction['shares'],
      pricePerShare: 50 as unknown as InsiderTransaction['pricePerShare'],
      valueUsd: 50_000 as unknown as InsiderTransaction['valueUsd'],
    }),
  ];
  const events = detectClusters(txns, { sinceHours: 168 });
  assert.equal(events.length, 0);
});

await test('single insider with $750k → LOW conviction', () => {
  const txns = [
    makeTxn({
      ticker: 'XYZ',
      insiderName: 'Solo Insider',
      shares: 7_500 as unknown as InsiderTransaction['shares'],
      pricePerShare: 100 as unknown as InsiderTransaction['pricePerShare'],
      valueUsd: 750_000 as unknown as InsiderTransaction['valueUsd'],
    }),
  ];
  const events = detectClusters(txns, { sinceHours: 168 });
  assert.equal(events.length, 1);
  assert.equal((events[0] as ClusterEvent).conviction, 'LOW');
});

await test('option exercises (M) are filtered out', () => {
  const txns = [
    makeTxn({
      ticker: 'OPT',
      insiderName: 'Exec',
      transactionCode: 'M',
      shares: 100_000 as unknown as InsiderTransaction['shares'],
      pricePerShare: 1 as unknown as InsiderTransaction['pricePerShare'],
      valueUsd: 100_000 as unknown as InsiderTransaction['valueUsd'],
    }),
    makeTxn({
      ticker: 'OPT',
      insiderName: 'Other',
      transactionCode: 'S',
      shares: 50_000 as unknown as InsiderTransaction['shares'],
      pricePerShare: 1 as unknown as InsiderTransaction['pricePerShare'],
      valueUsd: 50_000 as unknown as InsiderTransaction['valueUsd'],
    }),
  ];
  const events = detectClusters(txns, { sinceHours: 168 });
  assert.equal(events.length, 0);
});

await test('three insiders just over MEDIUM threshold but under $2M → MEDIUM not HIGH', () => {
  const ticker = 'MED';
  const txns = [
    makeTxn({
      ticker,
      insiderName: 'A',
      shares: 1000 as unknown as InsiderTransaction['shares'],
      pricePerShare: 400 as unknown as InsiderTransaction['pricePerShare'],
      valueUsd: 400_000 as unknown as InsiderTransaction['valueUsd'],
    }),
    makeTxn({
      ticker,
      insiderName: 'B',
      shares: 1000 as unknown as InsiderTransaction['shares'],
      pricePerShare: 400 as unknown as InsiderTransaction['pricePerShare'],
      valueUsd: 400_000 as unknown as InsiderTransaction['valueUsd'],
    }),
    makeTxn({
      ticker,
      insiderName: 'C',
      shares: 1000 as unknown as InsiderTransaction['shares'],
      pricePerShare: 400 as unknown as InsiderTransaction['pricePerShare'],
      valueUsd: 400_000 as unknown as InsiderTransaction['valueUsd'],
    }),
  ];
  const events = detectClusters(txns, { sinceHours: 168 });
  assert.equal(events.length, 1);
  const ev = events[0] as ClusterEvent;
  assert.equal(ev.conviction, 'MEDIUM');
});

await test('totalUsd ≥ $1M with one insider → MEDIUM via dollar threshold', () => {
  // One insider but big-ticket purchase. Per spec: "totalUsd ≥ minTotalUsd"
  // alone is enough for MEDIUM.
  const ticker = 'BIG';
  const txns = [
    makeTxn({
      ticker,
      insiderName: 'Whale',
      shares: 10_000 as unknown as InsiderTransaction['shares'],
      pricePerShare: 200 as unknown as InsiderTransaction['pricePerShare'],
      valueUsd: 2_000_000 as unknown as InsiderTransaction['valueUsd'],
    }),
  ];
  const events = detectClusters(txns, { sinceHours: 168 });
  assert.equal(events.length, 1);
  // Whale alone clears the $1M threshold → MEDIUM. (Single-insider path can
  // ALSO go LOW; the dollar gate wins because $2M > $1M.)
  assert.equal((events[0] as ClusterEvent).conviction, 'MEDIUM');
});

await test('older-than-window txns are skipped', () => {
  const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30d
  const txns = [
    makeTxn({
      ticker: 'STALE',
      insiderName: 'Old',
      transactionDate: old,
      shares: 10_000 as unknown as InsiderTransaction['shares'],
      pricePerShare: 100 as unknown as InsiderTransaction['pricePerShare'],
      valueUsd: 1_000_000 as unknown as InsiderTransaction['valueUsd'],
    }),
  ];
  const events = detectClusters(txns, { sinceHours: 7 * 24 });
  assert.equal(events.length, 0);
});

console.log('\n--- detectUpgrade ---');

function makeRec(
  override: Partial<AnalystRecommendation> &
    Pick<AnalystRecommendation, 'ticker' | 'period'>,
): AnalystRecommendation {
  return {
    id: 0,
    ticker: override.ticker,
    period: override.period,
    strongBuy: override.strongBuy ?? 0,
    buy: override.buy ?? 0,
    hold: override.hold ?? 0,
    sell: override.sell ?? 0,
    strongSell: override.strongSell ?? 0,
    fetchedAt: override.fetchedAt ?? new Date(),
  };
}

await test('consensus tier shift Hold → Buy fires upgrade', () => {
  const current = makeRec({
    ticker: 'AAA',
    period: new Date('2026-04-01T00:00:00Z'),
    strongBuy: 2,
    buy: 6,
    hold: 4,
    sell: 0,
    strongSell: 0,
  });
  const prior = makeRec({
    ticker: 'AAA',
    period: new Date('2026-03-01T00:00:00Z'),
    strongBuy: 1,
    buy: 4,
    hold: 7,
    sell: 0,
    strongSell: 0,
  });
  const ev = detectUpgrade([current, prior]);
  assert.ok(ev);
  assert.equal(ev!.fromConsensus, 'Hold');
  assert.equal(ev!.toConsensus, 'Buy');
});

await test('strongBuy + buy delta ≥ 2 fires upgrade even without tier shift', () => {
  const current = makeRec({
    ticker: 'BBB',
    period: new Date('2026-04-01T00:00:00Z'),
    strongBuy: 5,
    buy: 6,
    hold: 3,
  });
  const prior = makeRec({
    ticker: 'BBB',
    period: new Date('2026-03-01T00:00:00Z'),
    strongBuy: 4,
    buy: 5,
    hold: 3,
  });
  const ev = detectUpgrade([current, prior]);
  assert.ok(ev);
  assert.equal(ev!.deltaStrongBuy + ev!.deltaBuy, 2);
});

await test('flat / negligible movement returns null', () => {
  const current = makeRec({
    ticker: 'CCC',
    period: new Date('2026-04-01T00:00:00Z'),
    strongBuy: 3,
    buy: 4,
    hold: 5,
  });
  const prior = makeRec({
    ticker: 'CCC',
    period: new Date('2026-03-01T00:00:00Z'),
    strongBuy: 3,
    buy: 4,
    hold: 5,
  });
  const ev = detectUpgrade([current, prior]);
  assert.equal(ev, null);
});

await test('downgrade Hold → Sell does NOT fire upgrade', () => {
  const current = makeRec({
    ticker: 'DDD',
    period: new Date('2026-04-01T00:00:00Z'),
    strongBuy: 0,
    buy: 1,
    hold: 4,
    sell: 6,
  });
  const prior = makeRec({
    ticker: 'DDD',
    period: new Date('2026-03-01T00:00:00Z'),
    strongBuy: 0,
    buy: 1,
    hold: 7,
    sell: 2,
  });
  const ev = detectUpgrade([current, prior]);
  assert.equal(ev, null);
});

await test('rows.length < 2 returns null', () => {
  const only = makeRec({
    ticker: 'EEE',
    period: new Date('2026-04-01T00:00:00Z'),
    strongBuy: 5,
  });
  assert.equal(detectUpgrade([only]), null);
  assert.equal(detectUpgrade([]), null);
});

await test('consensusFromRow ties break bullish', () => {
  // 3 Buy / 3 Hold → tie; bullish wins.
  const out = consensusFromRow({
    strongBuy: 0,
    buy: 3,
    hold: 3,
    sell: 0,
    strongSell: 0,
  });
  assert.equal(out, 'Buy');
});

console.log('\n--- qualityFilter ---');

function fakeUniverse(
  partial: Partial<TickerUniverse> & { symbol: string },
): TickerUniverse {
  return {
    id: 1,
    symbol: partial.symbol,
    name: partial.name ?? 'Test Co',
    exchange: partial.exchange ?? 'US',
    currency: partial.currency ?? 'USD',
    symbolRaw: partial.symbolRaw ?? null,
    sector: partial.sector ?? null,
    marketCapUsd: (partial.marketCapUsd ?? null) as TickerUniverse['marketCapUsd'],
    aliases: partial.aliases ?? [],
    isLottery: partial.isLottery ?? false,
    lastRefreshed: partial.lastRefreshed ?? new Date(),
  };
}

await test('passes when all gates clear', async () => {
  const result = await qualityFilter(
    'AAPL',
    {},
    {
      loadUniverseRow: async () =>
        fakeUniverse({
          symbol: 'AAPL',
          marketCapUsd: 3_000_000_000_000 as unknown as TickerUniverse['marketCapUsd'],
        }),
      loadAvgDailyDollarVolume: async () => ({
        avgDollarVolume: 50_000_000,
        barCount: 20,
      }),
      hasTier1NewsLast30d: async () => true,
      loadMinMcapUsd: async () => 500_000_000,
    },
  );
  assert.equal(result.passes, true);
});

await test('rejects on no-universe-row', async () => {
  const result = await qualityFilter(
    'NOPE',
    {},
    {
      loadUniverseRow: async () => null,
      loadAvgDailyDollarVolume: async () => null,
      hasTier1NewsLast30d: async () => false,
      loadMinMcapUsd: async () => 500_000_000,
    },
  );
  assert.equal(result.passes, false);
  assert.equal(result.reason, 'no-universe-row');
});

await test('rejects on low-mcap', async () => {
  const result = await qualityFilter(
    'TINY',
    {},
    {
      loadUniverseRow: async () =>
        fakeUniverse({
          symbol: 'TINY',
          marketCapUsd: 100_000_000 as unknown as TickerUniverse['marketCapUsd'],
        }),
      loadAvgDailyDollarVolume: async () => ({
        avgDollarVolume: 50_000_000,
        barCount: 20,
      }),
      hasTier1NewsLast30d: async () => true,
      loadMinMcapUsd: async () => 500_000_000,
    },
  );
  assert.equal(result.passes, false);
  assert.equal(result.reason, 'low-mcap');
});

await test('rejects on lottery flag', async () => {
  const result = await qualityFilter(
    'LOTTO',
    {},
    {
      loadUniverseRow: async () =>
        fakeUniverse({
          symbol: 'LOTTO',
          marketCapUsd: 800_000_000 as unknown as TickerUniverse['marketCapUsd'],
          isLottery: true,
        }),
      loadAvgDailyDollarVolume: async () => ({
        avgDollarVolume: 10_000_000,
        barCount: 20,
      }),
      hasTier1NewsLast30d: async () => true,
      loadMinMcapUsd: async () => 500_000_000,
    },
  );
  assert.equal(result.passes, false);
  assert.equal(result.reason, 'lottery');
});

await test('rejects on low-volume', async () => {
  const result = await qualityFilter(
    'THIN',
    {},
    {
      loadUniverseRow: async () =>
        fakeUniverse({
          symbol: 'THIN',
          marketCapUsd: 1_000_000_000 as unknown as TickerUniverse['marketCapUsd'],
        }),
      loadAvgDailyDollarVolume: async () => ({
        avgDollarVolume: 1_000_000,
        barCount: 20,
      }),
      hasTier1NewsLast30d: async () => true,
      loadMinMcapUsd: async () => 500_000_000,
    },
  );
  assert.equal(result.passes, false);
  assert.equal(result.reason, 'low-volume');
});

await test('rejects on no-tier1-news', async () => {
  const result = await qualityFilter(
    'QUIET',
    {},
    {
      loadUniverseRow: async () =>
        fakeUniverse({
          symbol: 'QUIET',
          marketCapUsd: 1_000_000_000 as unknown as TickerUniverse['marketCapUsd'],
        }),
      loadAvgDailyDollarVolume: async () => ({
        avgDollarVolume: 50_000_000,
        barCount: 20,
      }),
      hasTier1NewsLast30d: async () => false,
      loadMinMcapUsd: async () => 500_000_000,
    },
  );
  assert.equal(result.passes, false);
  assert.equal(result.reason, 'no-tier1-news');
});

await test('rejects on stale-listing', async () => {
  const result = await qualityFilter(
    'STALE',
    {},
    {
      loadUniverseRow: async () =>
        fakeUniverse({
          symbol: 'STALE',
          marketCapUsd: 1_000_000_000 as unknown as TickerUniverse['marketCapUsd'],
          lastRefreshed: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
        }),
      loadAvgDailyDollarVolume: async () => ({
        avgDollarVolume: 50_000_000,
        barCount: 20,
      }),
      hasTier1NewsLast30d: async () => true,
      loadMinMcapUsd: async () => 500_000_000,
    },
  );
  assert.equal(result.passes, false);
  assert.equal(result.reason, 'stale-listing');
});

console.log('\n--- detectLotteryFromBars ---');

await test('flags low-priced + high-vol ticker', () => {
  // Construct a ticker bouncing wildly between $2 and $5.
  const bars = [];
  for (let i = 0; i < 30; i++) {
    bars.push({
      close: i % 2 === 0 ? 2 : 4.5,
      date: new Date(2026, 3, i + 1),
    });
  }
  const out = detectLotteryFromBars({ bars });
  assert.ok(out);
  assert.equal(out!.shouldFlag, true);
  assert.ok(out!.realizedVolAnnualized > 1.0);
});

await test('does NOT flag stable mid-cap', () => {
  const bars = [];
  for (let i = 0; i < 30; i++) {
    bars.push({
      close: 100 + Math.sin(i / 5) * 0.5,
      date: new Date(2026, 3, i + 1),
    });
  }
  const out = detectLotteryFromBars({ bars });
  assert.ok(out);
  assert.equal(out!.shouldFlag, false);
});

await test('returns null when too few bars', () => {
  const bars = [
    { close: 1, date: new Date('2026-04-01') },
    { close: 2, date: new Date('2026-04-02') },
  ];
  assert.equal(detectLotteryFromBars({ bars }), null);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
