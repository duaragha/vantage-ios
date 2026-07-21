import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  addZonedDays,
  startOfZonedDay,
  startOfZonedMonth,
  utcDateOnlyRange,
  zonedDateKey,
} from './zonedTime.js';

describe('timezone-aware query boundaries', () => {
  it('uses the Toronto day after UTC rolls into tomorrow', () => {
    const now = new Date('2026-07-17T02:30:00.000Z');
    assert.equal(zonedDateKey(now), '2026-07-16');
    assert.equal(startOfZonedDay(now).toISOString(), '2026-07-16T04:00:00.000Z');
    assert.equal(startOfZonedMonth(now).toISOString(), '2026-07-01T04:00:00.000Z');
  });

  it('resolves Toronto midnight on both daylight-saving transition days', () => {
    assert.equal(
      startOfZonedDay(new Date('2026-03-08T18:00:00.000Z')).toISOString(),
      '2026-03-08T05:00:00.000Z',
    );
    assert.equal(
      startOfZonedDay(new Date('2026-11-01T18:00:00.000Z')).toISOString(),
      '2026-11-01T04:00:00.000Z',
    );
  });

  it('honors a timezone other than the process timezone', () => {
    const now = new Date('2026-07-17T02:30:00.000Z');
    assert.equal(zonedDateKey(now, 'America/Vancouver'), '2026-07-16');
    assert.equal(
      startOfZonedDay(now, 'America/Vancouver').toISOString(),
      '2026-07-16T07:00:00.000Z',
    );
  });

  it('adds calendar days without assuming every local day is 24 hours', () => {
    const march7 = new Date('2026-03-07T17:00:00.000Z');
    const march8 = addZonedDays(march7, 1);
    const march9 = addZonedDays(march7, 2);
    assert.equal(march8.toISOString(), '2026-03-08T05:00:00.000Z');
    assert.equal(march9.toISOString(), '2026-03-09T04:00:00.000Z');
    assert.equal(march9.getTime() - march8.getTime(), 23 * 60 * 60 * 1000);
  });

  it('builds UTC-midnight bounds for provider date-only rows', () => {
    const range = utcDateOnlyRange(new Date('2026-07-17T02:30:00.000Z'), 1, 1);
    assert.equal(range.start.toISOString(), '2026-07-17T00:00:00.000Z');
    assert.equal(range.end.toISOString(), '2026-07-18T00:00:00.000Z');
  });
});
