import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeStoredDiscoveryMetrics } from './discoveryMetrics.js';

describe('stored discovery metric units', () => {
  it('normalizes provider percentages while preserving true ratios and multiples', () => {
    const normalized = normalizeStoredDiscoveryMetrics({
      peTtm: 28,
      roeTtm: 146.69,
      grossMarginTtm: 47.86,
      revenueGrowthYoy: 12.76,
      epsGrowth5y: 17.91,
      debtToEquity: 1.3547,
      currentRatio: 0.8933,
    });

    assert.equal(normalized.peTtm, 28);
    assert.ok(Math.abs((normalized.roeTtm ?? 0) - 1.4669) < 1e-12);
    assert.ok(Math.abs((normalized.grossMarginTtm ?? 0) - 0.4786) < 1e-12);
    assert.ok(Math.abs((normalized.revenueGrowthYoy ?? 0) - 0.1276) < 1e-12);
    assert.ok(Math.abs((normalized.epsGrowth5y ?? 0) - 0.1791) < 1e-12);
    assert.equal(normalized.debtToEquity, 1.3547);
    assert.equal(normalized.currentRatio, 0.8933);
  });
});
