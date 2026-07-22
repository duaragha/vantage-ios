import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parsePositionLotInput, torontoDateKey } from './positionLotInput.js';

describe('position lot input', () => {
  it('parses an honest calendar-date purchase', () => {
    const result = parsePositionLotInput(
      { shares: 2.5, costPerShare: 31.2, acquiredAt: '2026-07-20', note: 'Second buy' },
      '2026-07-21',
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.acquiredAtDate?.toISOString(), '2026-07-20T00:00:00.000Z');
    assert.equal(result.value.note, 'Second buy');
  });

  it('allows an unknown date for migrated holdings', () => {
    const result = parsePositionLotInput(
      { shares: 1, costPerShare: 10, acquiredAt: null, note: null },
      '2026-07-21',
    );
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.acquiredAtDate, null);
  });

  it('rejects impossible and future dates', () => {
    assert.equal(
      parsePositionLotInput(
        { shares: 1, costPerShare: 10, acquiredAt: '2026-02-31', note: null },
        '2026-07-21',
      ).ok,
      false,
    );
    assert.equal(
      parsePositionLotInput(
        { shares: 1, costPerShare: 10, acquiredAt: '2026-07-22', note: null },
        '2026-07-21',
      ).ok,
      false,
    );
  });

  it('uses the Toronto calendar date around UTC midnight', () => {
    assert.equal(torontoDateKey(new Date('2026-07-22T01:30:00.000Z')), '2026-07-21');
  });
});
