import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_WEIGHTS, type SignalBreakdown } from '@vantage/core/discover/signals';
import {
  collapseDailyScoreTrend,
  computeWindowStats,
  explainSwapSignals,
  normalizeSignalBreakdown,
  selectPriceSource,
  subtractBenchmarkReturn,
} from './compareResearch.ts';
import {
  SIGNAL_KEYS,
  canadianExchangeName,
  isCanadianListing,
  passesLensRiskGate,
  scoreForLens,
  type LensRow,
} from './discoveryLens.ts';

function breakdown(overrides: Partial<SignalBreakdown> = {}): SignalBreakdown {
  return {
    epsGrowth: 0,
    revenueGrowth: 0,
    margins: 0,
    valuation: 0,
    profitability: 0,
    balanceSheet: 0,
    liquidity: 0,
    size: 0,
    momentum: 0,
    news: 0,
    earnings: 0,
    insider: 0,
    filings: 0,
    sentiment: 0,
    ...overrides,
  };
}

function lensRow(overrides: Partial<LensRow> = {}): LensRow {
  return {
    ticker: 'TEST',
    name: 'Test Monthly Income Fund',
    score: 1,
    breakdown: breakdown({ balanceSheet: 8, profitability: 8, liquidity: 8 }),
    incomeCadence: 'monthly',
    incomeRiskFloor: 'aggressive',
    incomeYieldEstimate: 0.09,
    incomeYieldSource: 'curated',
    metrics: { dividendPayoutRatio: 70, beta: 1.2 },
    ...overrides,
  };
}

describe('compare signal contract', () => {
  it('normalizes all 14 persisted signals and rejects a truncated row', () => {
    assert.equal(SIGNAL_KEYS.length, 14);
    const complete = breakdown({ valuation: 9, momentum: -0.3 });
    assert.deepEqual(normalizeSignalBreakdown(complete), complete);

    const truncated = { ...complete } as Record<string, number>;
    delete truncated['valuation'];
    assert.equal(normalizeSignalBreakdown(truncated), null);
  });

  it('names the dominant fundamental contribution in a swap explanation', () => {
    const held = { ticker: 'OLD', score: 1, breakdown: breakdown({ valuation: 1 }) };
    const buy = { ticker: 'NEW', score: 2, breakdown: breakdown({ valuation: 10 }) };
    const explanation = explainSwapSignals(held, buy, DEFAULT_WEIGHTS);
    assert.match(explanation, /valuation 10\.0 vs 1\.0/);
    assert.match(explanation, /\+0\.90 score/);
  });
});

describe('price and relative-return research', () => {
  const now = Date.parse('2026-07-16T16:00:00.000Z');

  it('uses a live price below ten minutes and flips to last close above ten minutes', () => {
    const close = { close: 99, date: new Date('2026-07-15T20:00:00.000Z') };
    const fresh = selectPriceSource(
      now,
      { price: 101, fetchedAt: new Date(now - 9 * 60_000) },
      close,
    );
    assert.deepEqual(fresh, { price: 101, ageSeconds: 540, isLive: true });

    const stale = selectPriceSource(
      now,
      { price: 101, fetchedAt: new Date(now - 10 * 60_000 - 1) },
      close,
    );
    assert.equal(stale?.price, 99);
    assert.equal(stale?.isLive, false);
  });

  it('computes deterministic windows, 52-week range, and SPY alpha', () => {
    const bars = Array.from({ length: 252 }, (_, index) => ({
      close: 200 - index * 0.25,
      high: 205 - index * 0.2,
      low: 190 - index * 0.3,
    }));
    const stats = computeWindowStats(bars);
    assert.ok(stats);
    assert.equal(stats.high52, 205);
    assert.equal(stats.low52, 114.7);
    assert.ok(Math.abs((stats.r30 ?? 0) - 2.6958) < 0.001);
    assert.equal(subtractBenchmarkReturn(8.5, 3.25), 5.25);
  });

  it('keeps only the latest score per day in chronological order', () => {
    const trend = collapseDailyScoreTrend([
      { score: 1, computedAt: new Date('2026-07-14T10:00:00Z') },
      { score: 2, computedAt: new Date('2026-07-14T18:00:00Z') },
      { score: 3, computedAt: new Date('2026-07-15T18:00:00Z') },
    ]);
    assert.deepEqual(trend, [2, 3]);
  });
});

describe('shared compare/discovery lenses', () => {
  it('preserves a negative raw score instead of flattening it', () => {
    assert.equal(scoreForLens(lensRow({ score: -0.4 }), 'raw', 'moderate'), -0.4);
  });

  it('requires both monthly cadence and the risk-tier income floor', () => {
    assert.equal(
      passesLensRiskGate(lensRow({ incomeYieldEstimate: 0.09 }), 'income', 'aggressive'),
      true,
    );
    assert.equal(
      passesLensRiskGate(lensRow({ incomeYieldEstimate: 0.079 }), 'income', 'aggressive'),
      false,
    );
    assert.equal(
      passesLensRiskGate(
        lensRow({ incomeCadence: null, name: 'Quarterly Fund' }),
        'income',
        'aggressive',
      ),
      false,
    );
    assert.equal(
      passesLensRiskGate(
        lensRow({ incomeRiskFloor: 'aggressive', incomeYieldEstimate: 0.12 }),
        'income',
        'high',
      ),
      false,
    );
    assert.equal(
      passesLensRiskGate(
        lensRow({ incomeRiskFloor: 'high', incomeYieldEstimate: 0.07 }),
        'income',
        'high',
      ),
      true,
    );
  });

  it('recognizes Canadian listings across ticker, currency, and provider exchange names', () => {
    assert.equal(isCanadianListing({ ticker: 'VDY.TO', exchange: 'US', currency: 'USD' }), true);
    assert.equal(isCanadianListing({ ticker: 'RY', exchange: 'TSX', currency: 'USD' }), true);
    assert.equal(
      isCanadianListing({
        ticker: 'RY',
        exchange: 'TORONTO STOCK EXCHANGE',
        currency: 'USD',
      }),
      true,
    );
    assert.equal(
      canadianExchangeName({ ticker: 'TEST', exchange: 'CBOE CANADA', currency: 'CAD' }),
      'NEO / Cboe Canada',
    );
    assert.equal(
      isCanadianListing({ ticker: 'AAPL', exchange: 'NASDAQ NMS', currency: 'USD' }),
      false,
    );
  });
});
