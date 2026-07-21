import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildRotationActionJson,
  isInsightActionable,
  normalizeInsightAction,
} from './insightActions.ts';

describe('rotation action contract', () => {
  it('round-trips a VDY.TO to XEI.TO compare acceptance with XEI.TO as the buy prefill', () => {
    const written = buildRotationActionJson({
      trimTicker: 'vdy.to',
      buyTicker: 'xei.to',
      scoreDelta: 0.72,
      source: 'compare-ui',
    });
    const action = normalizeInsightAction(written);

    assert.equal(action?.type, 'rotation');
    assert.equal(action?.trimTicker, 'VDY.TO');
    assert.equal(action?.buyTicker, 'XEI.TO');
    assert.equal(action?.ticker, 'XEI.TO');
    assert.equal(action?.trimPriceCurrency, 'CAD');
    assert.equal(action?.priceCurrency, 'CAD');
    assert.equal(action?.replacementFound, true);
  });

  it('repairs the legacy manual rotation shape at the read boundary', () => {
    const action = normalizeInsightAction({
      type: 'rotation',
      ticker: 'VDY.TO',
      targetTicker: 'XEI.TO',
      shares: null,
    });

    assert.equal(action?.trimTicker, 'VDY.TO');
    assert.equal(action?.buyTicker, 'XEI.TO');
    assert.equal(action?.ticker, 'XEI.TO');
  });

  it('repairs cap-driven legacy rotate rows without reusing trim sizing as buy sizing', () => {
    const action = normalizeInsightAction({
      type: 'rebalance',
      action: 'rotate',
      ticker: 'VDY.TO',
      targetTicker: 'XEI.TO',
      shares: 12,
      priceSnapshot: 50,
      priceCurrency: 'CAD',
    });

    assert.equal(action?.type, 'rotation');
    assert.equal(action?.ticker, 'XEI.TO');
    assert.equal(action?.trimTicker, 'VDY.TO');
    assert.equal(action?.trimShares, 12);
    assert.equal(action?.buyShares, null);
    assert.equal(action?.shares, null);
    assert.equal(action?.trimPriceSnapshot, 50);
    assert.equal(action?.priceSnapshot, null);
    assert.equal(action?.priceCurrency, 'CAD');
    assert.equal(action?.trimPriceCurrency, 'CAD');
  });

  it('preserves thesis position identity without turning the update into a buy', () => {
    const action = normalizeInsightAction({
      type: 'thesis-update',
      ticker: 'AAPL',
      positionId: 31,
    });
    assert.equal(action?.type, 'thesis-update');
    assert.equal(action?.ticker, 'AAPL');
    assert.equal(action?.positionId, 31);
    assert.equal(isInsightActionable('ThesisUpdate', 'New', action), false);
  });

  it('hydrates a legacy thesis ticker from its position without making it actionable', () => {
    const action = normalizeInsightAction(
      { type: 'thesis-update', positionId: 31 },
      { positionTicker: 'aapl' },
    );
    assert.equal(action?.ticker, 'AAPL');
    assert.equal(action?.positionId, 31);
    assert.equal(isInsightActionable('ThesisUpdate', 'New', action), false);
  });

  it('allows only actual buy suggestions and rotations into the Bought flow', () => {
    const rotation = normalizeInsightAction({
      type: 'rotation',
      ticker: 'XEI.TO',
      trimTicker: 'VDY.TO',
      buyTicker: 'XEI.TO',
    });
    const trim = normalizeInsightAction({
      type: 'rebalance',
      action: 'trim',
      ticker: 'AAPL',
      replacementConsidered: true,
      replacementFound: false,
    });
    assert.equal(isInsightActionable('Rebalance', 'New', rotation), true);
    assert.equal(isInsightActionable('Rebalance', 'New', trim), false);
    assert.equal(isInsightActionable('BuySuggestion', 'Bought', rotation), false);
  });
});
