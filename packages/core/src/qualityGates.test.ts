import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectLotteryFromBars } from './qualityGates.js';

function bars(closes: number[]): Array<{ close: number; date: Date }> {
  return closes.map((close, index) => ({
    close,
    date: new Date(Date.UTC(2026, 5, index + 1)),
  }));
}

describe('detectLotteryFromBars', () => {
  it('flags a sub-$5 ticker with extreme realized volatility', () => {
    const result = detectLotteryFromBars({
      bars: bars([2, 4, 2, 4, 2, 4, 2, 4, 2, 4, 2, 4]),
    });
    assert.equal(result?.shouldFlag, true);
    assert.ok((result?.realizedVolAnnualized ?? 0) > 1);
  });

  it('does not flag the same volatility when the latest price is at least $5', () => {
    const result = detectLotteryFromBars({
      bars: bars([6, 12, 6, 12, 6, 12, 6, 12, 6, 12, 6, 12]),
    });
    assert.equal(result?.shouldFlag, false);
  });

  it('does not flag a stable low-priced ticker', () => {
    const result = detectLotteryFromBars({
      bars: bars([2, 2.01, 2, 2.02, 2.01, 2, 2.01, 2.02, 2.01, 2]),
    });
    assert.equal(result?.shouldFlag, false);
  });

  it('leaves the existing flag untouched when history is insufficient', () => {
    assert.equal(detectLotteryFromBars({ bars: bars([2, 4, 2, 4, 2]) }), null);
  });
});
