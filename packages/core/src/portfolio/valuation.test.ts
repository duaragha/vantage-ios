import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Position } from '@vantage/db';
import { auditPortfolio, currenciesByTicker } from './valuation.js';
import { checkCaps, computeConcentration } from '../rebalance/metrics.js';
import { evaluateRotationCaps } from '../discover/rotation.js';

const USD_CAD = 1.36;

function position(
  ticker: string,
  nativeValue: number,
  currency: 'USD' | 'CAD',
  sector: string,
): Position {
  return {
    id: ticker.length,
    ticker,
    shares: 1,
    avgCost: nativeValue,
    currency,
    category: 'Other',
    sector,
    openedAt: new Date('2026-01-01T00:00:00Z'),
    closedAt: null,
    notes: null,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    accountId: 1,
  } as unknown as Position;
}

describe('mixed-currency portfolio valuation', () => {
  const positions = [
    position('USDCO', 50_000, 'USD', 'Technology'),
    position('CADCO.TO', 50_000, 'CAD', 'Financials'),
  ];

  it('audits $50k USD plus C$50k as USD and CAD totals', () => {
    const audit = auditPortfolio({ positions, usdCadRate: USD_CAD });
    assert.ok(Math.abs(audit.totalValueUsd - 86_764.705882) < 0.001);
    assert.ok(Math.abs(audit.totalValueCad - 118_000) < 0.001);
    assert.ok(Math.abs(audit.byTicker.get('USDCO')!.pct - 57.627119) < 0.001);
    assert.ok(Math.abs(audit.byTicker.get('CADCO.TO')!.pct - 42.372881) < 0.001);
  });

  it('feeds the same totals and weights into concentration checks', () => {
    const concentration = computeConcentration({
      positions,
      prices: { USDCO: 50_000, 'CADCO.TO': 50_000 },
      currencies: currenciesByTicker(positions),
      usdCadRate: USD_CAD,
    });
    assert.ok(Math.abs(concentration.totalValue - 86_764.705882) < 0.001);
    assert.ok(Math.abs(concentration.totalValueCad - 118_000) < 0.001);

    const caps = checkCaps(concentration, {
      singlePositionCapPct: 55,
      sectorCapPct: 100,
    });
    assert.deepEqual(
      caps.violations.map((violation) => violation.ticker),
      ['USDCO'],
      'the old 50/50 native-currency math masked this USD holding breach',
    );
  });

  it('uses USD-equivalent trim proceeds in rotation cap checks', () => {
    const concentration = computeConcentration({
      positions,
      prices: { USDCO: 50_000, 'CADCO.TO': 50_000 },
      currencies: currenciesByTicker(positions),
      usdCadRate: USD_CAD,
    });
    const result = evaluateRotationCaps({
      concentration,
      buyTicker: 'NEWCO',
      buySector: 'Industrials',
      trimSector: 'Financials',
      trimValueUsd: 12_500 / USD_CAD,
      singlePositionCapPct: 11,
      sectorCapPct: 100,
    });
    assert.equal(result.ok, true);
    assert.ok(Math.abs(result.newBuyPct - 10.59322) < 0.001);
  });
});
