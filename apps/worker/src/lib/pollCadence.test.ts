import assert from 'node:assert/strict';
import { it } from 'node:test';
import {
  easternClock,
  includeQuarterlyFilingForms,
  isUsMarketHoliday,
  OVERNIGHT_EVERY_30M,
  OVERNIGHT_HOURLY,
  offPeakPollDue,
  pricePollDue,
} from './pollCadence.js';

// July is EDT: ET = UTC-4. All fixtures use explicit UTC instants.
const et = (isoLocal: string): Date => new Date(`${isoLocal}-04:00`);

it('reads the eastern clock', () => {
  const clock = easternClock(et('2026-07-21T09:31:00'));
  assert.equal(clock.weekday, 'Tue');
  assert.equal(clock.hour, 9);
  assert.equal(clock.minute, 31);
  assert.equal(clock.dateKey, '2026-07-21');
});

it('knows the NYSE holiday table and fails open past it', () => {
  assert.equal(isUsMarketHoliday(et('2026-07-03T10:00:00')), true);
  assert.equal(isUsMarketHoliday(et('2026-07-21T10:00:00')), false);
  // Beyond the table's horizon: treated as a trading day (fail open).
  assert.equal(isUsMarketHoliday(new Date('2028-01-17T15:00:00Z')), false);
});

it('price polls every minute in the regular session', () => {
  assert.equal(pricePollDue(et('2026-07-21T09:31:00')), true);
  assert.equal(pricePollDue(et('2026-07-21T15:59:00')), true);
  // Session margin: 9:25 and 16:04 still per-minute.
  assert.equal(pricePollDue(et('2026-07-21T09:26:00')), true);
  assert.equal(pricePollDue(et('2026-07-21T16:04:00')), true);
});

it('price polls every 5 minutes pre/after-hours', () => {
  assert.equal(pricePollDue(et('2026-07-21T04:05:00')), true);
  assert.equal(pricePollDue(et('2026-07-21T04:07:00')), false);
  assert.equal(pricePollDue(et('2026-07-21T18:15:00')), true);
  assert.equal(pricePollDue(et('2026-07-21T18:16:00')), false);
});

it('price polls every 15 minutes on US market holidays', () => {
  assert.equal(pricePollDue(et('2026-07-03T10:00:00')), true);
  assert.equal(pricePollDue(et('2026-07-03T10:15:00')), true);
  assert.equal(pricePollDue(et('2026-07-03T10:05:00')), false);
  assert.equal(pricePollDue(et('2026-07-03T10:01:00')), false);
});

it('thins the 5-minute pollers to 30-minute cadence overnight', () => {
  // Daytime: every tick runs.
  assert.equal(offPeakPollDue(et('2026-07-21T14:35:00'), OVERNIGHT_EVERY_30M), true);
  assert.equal(offPeakPollDue(et('2026-07-21T21:55:00'), OVERNIGHT_EVERY_30M), true);
  // Quiet window (22:00-06:00 ET): only :00 and :30 run.
  assert.equal(offPeakPollDue(et('2026-07-21T23:00:00'), OVERNIGHT_EVERY_30M), true);
  assert.equal(offPeakPollDue(et('2026-07-21T23:30:00'), OVERNIGHT_EVERY_30M), true);
  assert.equal(offPeakPollDue(et('2026-07-21T23:05:00'), OVERNIGHT_EVERY_30M), false);
  assert.equal(offPeakPollDue(et('2026-07-22T03:45:00'), OVERNIGHT_EVERY_30M), false);
  // Window edges.
  assert.equal(offPeakPollDue(et('2026-07-21T22:05:00'), OVERNIGHT_EVERY_30M), false);
  assert.equal(offPeakPollDue(et('2026-07-22T06:05:00'), OVERNIGHT_EVERY_30M), true);
});

it('thins the 15-minute pollers to hourly overnight', () => {
  assert.equal(offPeakPollDue(et('2026-07-21T23:00:00'), OVERNIGHT_HOURLY), true);
  assert.equal(offPeakPollDue(et('2026-07-21T23:15:00'), OVERNIGHT_HOURLY), false);
  assert.equal(offPeakPollDue(et('2026-07-21T23:45:00'), OVERNIGHT_HOURLY), false);
  assert.equal(offPeakPollDue(et('2026-07-21T12:45:00'), OVERNIGHT_HOURLY), true);
});

it('includes quarterly EDGAR forms only on the top-of-hour tick', () => {
  assert.equal(includeQuarterlyFilingForms(et('2026-07-21T14:00:00')), true);
  assert.equal(includeQuarterlyFilingForms(et('2026-07-21T14:04:00')), true);
  assert.equal(includeQuarterlyFilingForms(et('2026-07-21T14:05:00')), false);
  assert.equal(includeQuarterlyFilingForms(et('2026-07-21T14:55:00')), false);
});
