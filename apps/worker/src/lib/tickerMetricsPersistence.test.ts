import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildTickerMetricsCreate, buildTickerMetricsUpdate } from './tickerMetricsPersistence.js';

const SAMPLE = {
  ticker: 'AAPL',
  fetchedAt: new Date('2026-07-17T12:00:00Z'),
  peTtm: 31.2,
  roeTtm: null,
  avgVolume30d: 42_000_000,
  avgDollarVolume30d: null,
  source: 'finnhub',
};

describe('ticker metrics persistence', () => {
  it('preserves prior values when a fresh provider field is null', () => {
    assert.deepEqual(buildTickerMetricsUpdate(SAMPLE, true), {
      fetchedAt: SAMPLE.fetchedAt,
      peTtm: 31.2,
      avgVolume30d: 42_000_000,
      source: 'finnhub',
    });
  });

  it('updates only computed liquidity and leaves the row retryable on provider failure', () => {
    assert.deepEqual(buildTickerMetricsUpdate(SAMPLE, false), {
      avgVolume30d: 42_000_000,
    });
    assert.equal(buildTickerMetricsCreate(SAMPLE, false).fetchedAt.getTime(), 0);
  });

  it('caches a completed no-fundamentals response without clearing prior ratios', () => {
    const noFundamentals = {
      ...SAMPLE,
      peTtm: null,
      source: 'yfinance-no-fundamentals',
    };
    assert.equal(buildTickerMetricsCreate(noFundamentals, true).fetchedAt, SAMPLE.fetchedAt);
    assert.deepEqual(buildTickerMetricsUpdate(noFundamentals, true), {
      fetchedAt: SAMPLE.fetchedAt,
      avgVolume30d: SAMPLE.avgVolume30d,
      source: 'yfinance-no-fundamentals',
    });
  });
});
