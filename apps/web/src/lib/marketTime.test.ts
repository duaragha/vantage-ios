import assert from 'node:assert/strict';
import { it } from 'node:test';
import { isTorontoDateKeyInPast, torontoDateKey, torontoTradingDaysBetween } from './marketTime.ts';

it('keeps the Toronto calendar date after UTC rolls into tomorrow', () => {
  assert.equal(torontoDateKey(new Date('2026-07-17T02:30:00Z')), '2026-07-16');
  assert.equal(torontoDateKey(new Date('2026-12-17T03:30:00Z')), '2026-12-16');
});

it('compares HTML date values against the Toronto calendar day', () => {
  const now = new Date('2026-07-17T02:30:00Z');
  assert.equal(isTorontoDateKeyInPast('2026-07-15', now), true);
  assert.equal(isTorontoDateKeyInPast('2026-07-16', now), false);
  assert.equal(isTorontoDateKeyInPast('2026-07-17', now), false);
  assert.equal(isTorontoDateKeyInPast('not-a-date', now), false);
});

it('counts trading weekdays using Toronto dates rather than the process timezone', () => {
  const thursdayEveningToronto = new Date('2026-07-17T02:30:00.000Z');
  const mondayMorningToronto = new Date('2026-07-20T13:00:00.000Z');
  assert.equal(torontoTradingDaysBetween(thursdayEveningToronto, mondayMorningToronto), 2);
  assert.equal(torontoTradingDaysBetween(mondayMorningToronto, thursdayEveningToronto), 0);
});
