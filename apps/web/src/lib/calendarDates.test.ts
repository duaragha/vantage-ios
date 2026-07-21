import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calendarArticleDateKey, calendarEventDateKey } from './calendarDates.js';

describe('catalyst calendar date semantics', () => {
  const midnightUtc = new Date('2026-07-18T00:00:00.000Z');

  it('keeps provider earnings report dates on their encoded UTC date', () => {
    assert.equal(calendarEventDateKey('Earnings', midnightUtc, 'America/Toronto'), '2026-07-18');
    assert.equal(calendarArticleDateKey(midnightUtc), '2026-07-18');
  });

  it('buckets real event timestamps in the configured timezone', () => {
    assert.equal(calendarEventDateKey('Macro', midnightUtc, 'America/Toronto'), '2026-07-17');
  });
});
