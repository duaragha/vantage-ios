import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { easternCalendarDate, easternDateKey, startOfEasternDay } from './marketTime.js';

describe('eastern market dates', () => {
  it('uses the prior ET day during the UTC evening rollover', () => {
    const now = new Date('2026-07-17T02:30:00Z');
    assert.equal(easternDateKey(now), '2026-07-16');
    assert.equal(easternCalendarDate(now).toISOString(), '2026-07-16T00:00:00.000Z');
    assert.equal(startOfEasternDay(now).toISOString(), '2026-07-16T04:00:00.000Z');
  });

  it('resolves midnight correctly on both daylight-saving transition days', () => {
    assert.equal(
      startOfEasternDay(new Date('2026-03-08T18:00:00Z')).toISOString(),
      '2026-03-08T05:00:00.000Z',
    );
    assert.equal(
      startOfEasternDay(new Date('2026-11-01T18:00:00Z')).toISOString(),
      '2026-11-01T04:00:00.000Z',
    );
  });
});
