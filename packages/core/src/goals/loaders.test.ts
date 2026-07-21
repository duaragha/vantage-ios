import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SecurityRecommendation } from './engine.js';
import { bestRecommendationForTicker } from './loaders.js';

function recommendation(
  ticker: string,
  category: 'IndividualStock' | 'CoveredCall',
  fitScore: number,
) {
  return {
    kind: 'curated',
    security: {
      ticker,
      name: ticker,
      category,
      currency: 'USD',
      description: ticker,
      suboptimalAccounts: [],
    },
    reason: `${ticker} reason`,
    fitScore,
    optimalForAccount: false,
  } satisfies SecurityRecommendation;
}

describe('goal recommendation ticker matching', () => {
  it('requires the exact ticker instead of accepting a shared category', () => {
    const recommendations = [
      recommendation('AAPL', 'IndividualStock', 90),
      recommendation('MSFT', 'IndividualStock', 85),
    ];

    assert.equal(bestRecommendationForTicker(recommendations, 'NVDA'), null);
    assert.equal(bestRecommendationForTicker(recommendations, 'msft')?.fitScore, 85);
  });

  it('returns the strongest exact match if duplicate sources exist', () => {
    const recommendations = [
      recommendation('JEPI', 'CoveredCall', 72),
      recommendation('JEPI', 'CoveredCall', 88),
    ];

    assert.equal(bestRecommendationForTicker(recommendations, 'JEPI')?.fitScore, 88);
  });
});
