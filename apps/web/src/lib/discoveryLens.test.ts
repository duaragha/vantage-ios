import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildReasons,
  defaultDiscoveryLens,
  hasDataForLens,
  incomeYield,
  passesLensRiskGate,
  payoutScore,
  resolveIncomeYieldEstimate,
  type LensRow,
} from './discoveryLens.js';

function monthlyIncomeRow(overrides: Partial<LensRow>): LensRow {
  return {
    ticker: 'O',
    name: 'Realty Income',
    score: 5,
    breakdown: null,
    incomeCadence: 'monthly',
    ...overrides,
  };
}

describe('discovery income units', () => {
  it('keeps curated fallbacks available only to Income before the first score run', () => {
    const fallback = monthlyIncomeRow({ scoreAvailable: false });

    assert.equal(defaultDiscoveryLens([fallback]), 'income');
    assert.equal(hasDataForLens(fallback, 'income'), true);
    assert.equal(hasDataForLens(fallback, 'growth'), false);
    assert.equal(
      defaultDiscoveryLens([fallback, monthlyIncomeRow({ scoreAvailable: true })]),
      'growth',
    );
  });

  it('does not mistake a sub-1 percent database yield for a decimal ratio', () => {
    const row = monthlyIncomeRow({
      incomeYieldEstimate: 0.45,
      incomeYieldSource: 'metrics',
    });

    assert.ok(Math.abs(incomeYield(row) - 0.0045) < 1e-12);
    assert.equal(passesLensRiskGate(row, 'income', 'aggressive'), false);
  });

  it('accepts percentage-point database yields and decimal curated yields', () => {
    const live = monthlyIncomeRow({
      incomeYieldEstimate: 9.5,
      incomeYieldSource: 'metrics',
    });
    const curated = monthlyIncomeRow({
      incomeYieldEstimate: 0.095,
      incomeYieldSource: 'curated',
    });

    assert.equal(incomeYield(live), 0.095);
    assert.equal(incomeYield(curated), 0.095);
    assert.equal(passesLensRiskGate(live, 'income', 'aggressive'), true);
    assert.equal(passesLensRiskGate(curated, 'income', 'aggressive'), true);
  });

  it('falls back when a provider stores zero for a known monthly payer', () => {
    assert.deepEqual(resolveIncomeYieldEstimate(0, 0.095), {
      estimate: 0.095,
      source: 'curated',
    });
    assert.deepEqual(resolveIncomeYieldEstimate(9.5, 0.095), {
      estimate: 9.5,
      source: 'metrics',
    });
    assert.deepEqual(resolveIncomeYieldEstimate(Number.POSITIVE_INFINITY, null), {
      estimate: null,
      source: null,
    });
  });

  it('does not leak an Aggressive income product into lower risk lenses', () => {
    const aggressiveProduct = monthlyIncomeRow({
      incomeRiskFloor: 'aggressive',
      incomeYieldEstimate: 0.12,
      incomeYieldSource: 'curated',
    });
    const highProduct = monthlyIncomeRow({
      incomeRiskFloor: 'high',
      incomeYieldEstimate: 0.075,
      incomeYieldSource: 'curated',
    });

    assert.equal(passesLensRiskGate(aggressiveProduct, 'income', 'high'), false);
    assert.equal(passesLensRiskGate(aggressiveProduct, 'income', 'aggressive'), true);
    assert.equal(passesLensRiskGate(highProduct, 'income', 'moderate'), false);
    assert.equal(passesLensRiskGate(highProduct, 'income', 'high'), true);
  });

  it('puts product risk in the visible income explanation', () => {
    const row = monthlyIncomeRow({
      curatedIncome: true,
      incomeRiskFloor: 'aggressive',
      incomeYieldEstimate: 0.12,
      incomeYieldSource: 'curated',
    });

    assert.deepEqual(buildReasons(row, 'income', 'aggressive').slice(0, 3), [
      'yield 12%',
      'monthly payer',
      'product risk: aggressive',
    ]);
  });

  it('treats payout ratios from TickerMetrics as percentage points', () => {
    const row = monthlyIncomeRow({ metrics: { dividendPayoutRatio: 75 } });
    assert.equal(payoutScore(row), 10);
  });
});
