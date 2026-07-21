import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { percentagePointsToRatio } from './units.js';

describe('financial units', () => {
  it('converts percentage points without guessing from magnitude', () => {
    assert.equal(percentagePointsToRatio(12.5), 0.125);
    assert.equal(percentagePointsToRatio(0.45), 0.0045000000000000005);
    assert.equal(percentagePointsToRatio(-8), -0.08);
  });

  it('rejects missing and non-finite values', () => {
    assert.equal(percentagePointsToRatio(null), null);
    assert.equal(percentagePointsToRatio(undefined), null);
    assert.equal(percentagePointsToRatio(Number.NaN), null);
  });
});
