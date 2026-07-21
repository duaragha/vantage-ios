import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseBacktestRequest } from './backtestRequest.js';

const VALID = {
  startDate: '2025-01-01',
  endDate: '2025-12-31',
  strategy: 'monthly-allocation',
  initialCashUsd: 10_000,
  monthlyBudgetUsd: 500,
  caps: { singlePositionCapPct: 25, sectorCapPct: 60 },
};

describe('backtest request validation', () => {
  it('normalizes valid tickers and preserves bounded strategy options', () => {
    const result = parseBacktestRequest({
      ...VALID,
      strategy: 'catalyst-driven',
      candidateUniverse: [' aapl ', 'AAPL', 'vdy.to'],
      seedPositions: [{ ticker: ' msft ', shares: 2.5, avgCost: 100 }],
      sectors: { aapl: 'Technology', 'VDY.TO': null },
      holdingDays: 30,
      catalystMaxPerDay: 2,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value.candidateUniverse, ['AAPL', 'VDY.TO']);
    assert.deepEqual(result.value.seedPositions, [{ ticker: 'MSFT', shares: 2.5, avgCost: 100 }]);
    assert.deepEqual(result.value.sectors, { AAPL: 'Technology', 'VDY.TO': null });
    assert.equal(result.value.holdingDays, 30);
  });

  it('applies documented numeric defaults when optional fields are absent', () => {
    const result = parseBacktestRequest({
      startDate: '2025-01-01',
      endDate: '2025-12-31',
      strategy: 'rebalance-only',
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.initialCashUsd, 0);
    assert.equal(result.value.monthlyBudgetUsd, 0);
    assert.deepEqual(result.value.caps, { singlePositionCapPct: 25, sectorCapPct: 60 });
  });

  it('rejects invalid or reversed calendar dates', () => {
    for (const body of [
      { ...VALID, startDate: '2025-02-30' },
      { ...VALID, endDate: '2025-01-01' },
      { ...VALID, startDate: '01/01/2025' },
    ]) {
      assert.equal(parseBacktestRequest(body).ok, false);
    }
  });

  it('rejects non-finite or out-of-range money and caps', () => {
    for (const body of [
      { ...VALID, initialCashUsd: Number.POSITIVE_INFINITY },
      { ...VALID, monthlyBudgetUsd: -1 },
      { ...VALID, caps: { singlePositionCapPct: 0, sectorCapPct: 60 } },
      { ...VALID, caps: { singlePositionCapPct: 25, sectorCapPct: 101 } },
    ]) {
      assert.equal(parseBacktestRequest(body).ok, false);
    }
  });

  it('rejects malformed and duplicate seed positions', () => {
    assert.equal(
      parseBacktestRequest({
        ...VALID,
        seedPositions: [
          { ticker: 'AAPL', shares: 1, avgCost: 100 },
          { ticker: 'aapl', shares: 2, avgCost: 90 },
        ],
      }).ok,
      false,
    );
    assert.equal(
      parseBacktestRequest({
        ...VALID,
        seedPositions: [{ ticker: 'AAPL', shares: -1, avgCost: 100 }],
      }).ok,
      false,
    );
  });

  it('rejects malformed universes, sectors, and strategy limits', () => {
    for (const body of [
      { ...VALID, candidateUniverse: ['AAPL', 'not a ticker'] },
      { ...VALID, sectors: { AAPL: 42 } },
      { ...VALID, holdingDays: 0 },
      { ...VALID, catalystMaxPerDay: 1.5 },
      { ...VALID, strategy: 'guess-and-hope' },
    ]) {
      assert.equal(parseBacktestRequest(body).ok, false);
    }
  });
});
