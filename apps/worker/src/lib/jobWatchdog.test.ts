import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  expectedMaturedRun,
  findSilentSchedules,
  pendingSilentAlerts,
  watchdogAlertKey,
  type WatchedSchedule,
} from './jobWatchdog.js';

const TIMEZONE = 'America/Toronto';
const DAILY: WatchedSchedule = {
  name: 'discover.compute',
  expr: '0 18 * * 1-5',
};

describe('job watchdog schedule expectations', () => {
  it('waits 15 minutes for a daily slot, then requires that exact slot', () => {
    const beforeGrace = expectedMaturedRun(DAILY, new Date('2026-07-16T22:10:00Z'), TIMEZONE);
    assert.equal(beforeGrace.expectedAt.toISOString(), '2026-07-15T22:00:00.000Z');

    const afterGrace = expectedMaturedRun(DAILY, new Date('2026-07-16T22:16:00Z'), TIMEZONE);
    assert.equal(afterGrace.expectedAt.toISOString(), '2026-07-16T22:00:00.000Z');
    assert.equal(afterGrace.deadlineAt.toISOString(), '2026-07-16T22:15:00.000Z');
  });

  it('uses 1.5 periods for frequent jobs', () => {
    const expected = expectedMaturedRun(
      { name: 'poll.news', expr: '*/5 * * * 1-5' },
      new Date('2026-07-16T14:08:00Z'),
      TIMEZONE,
    );
    assert.equal(expected.expectedAt.toISOString(), '2026-07-16T14:05:00.000Z');
    assert.equal(expected.allowedLatenessMs, 2.5 * 60 * 1000);
  });

  it('flags a missed matured slot but accepts a row at the slot boundary', () => {
    const now = new Date('2026-07-16T22:30:00Z');
    const stale = new Map([['discover.compute', new Date('2026-07-15T22:00:01Z')]]);
    assert.deepEqual(
      findSilentSchedules([DAILY], stale, now, TIMEZONE).map((row) => row.name),
      ['discover.compute'],
    );

    const current = new Map([['discover.compute', new Date('2026-07-16T22:00:01Z')]]);
    assert.equal(findSilentSchedules([DAILY], current, now, TIMEZONE).length, 0);
  });

  it('ignores every slot that predates this worker process', () => {
    const monitoringStartedAt = new Date('2026-07-16T22:15:00Z');
    const now = new Date('2026-07-16T22:15:05Z');
    const latest = new Map<string, Date>();
    const silent = findSilentSchedules(
      [{ name: 'alert.dispatch', expr: '*/30 * * * * *' }, DAILY],
      latest,
      now,
      TIMEZONE,
      monitoringStartedAt,
    );
    assert.deepEqual(silent, []);
  });

  it('still reports a daily slot that matured after this worker started', () => {
    const monitoringStartedAt = new Date('2026-07-16T21:45:00Z');
    const now = new Date('2026-07-16T22:16:00Z');
    const silent = findSilentSchedules([DAILY], new Map(), now, TIMEZONE, monitoringStartedAt);
    assert.deepEqual(
      silent.map((row) => row.name),
      ['discover.compute'],
    );
  });

  it('alerts a missed slot once but allows the next scheduled slot', () => {
    const first = findSilentSchedules(
      [DAILY],
      new Map(),
      new Date('2026-07-16T22:30:00Z'),
      TIMEZONE,
    );
    assert.equal(first.length, 1);

    const alerted = new Set([watchdogAlertKey(first[0]!)]);
    assert.deepEqual(pendingSilentAlerts(first, alerted), []);

    const next = findSilentSchedules(
      [DAILY],
      new Map(),
      new Date('2026-07-17T22:30:00Z'),
      TIMEZONE,
    );
    assert.equal(pendingSilentAlerts(next, alerted).length, 1);
  });
});

describe('liveness merge', () => {
  it('prefers the newest signal per job across DB rows and tick registry', async () => {
    const { mergeLiveness } = await import('./jobWatchdog.js');
    const db = new Map([
      ['alert.dispatch', new Date('2026-07-21T12:00:00Z')],
      ['poll.news', new Date('2026-07-21T12:04:00Z')],
    ]);
    const ticks = new Map([
      ['alert.dispatch', new Date('2026-07-21T12:09:30Z')],
      ['telegram.dispatch', new Date('2026-07-21T12:09:45Z')],
    ]);
    const merged = mergeLiveness(db, ticks);
    assert.deepEqual(merged.get('alert.dispatch'), new Date('2026-07-21T12:09:30Z'));
    assert.deepEqual(merged.get('poll.news'), new Date('2026-07-21T12:04:00Z'));
    assert.deepEqual(merged.get('telegram.dispatch'), new Date('2026-07-21T12:09:45Z'));
  });

  it('keeps an idle-skipped 30s job out of the silent list', () => {
    const now = new Date('2026-07-21T12:10:00Z');
    const schedule: WatchedSchedule = { name: 'alert.dispatch', expr: '*/30 * * * * *' };
    // DB row is ancient (queue idle for hours) but the registry saw a tick.
    const silentWithoutTicks = findSilentSchedules(
      [schedule],
      new Map([['alert.dispatch', new Date('2026-07-21T08:00:00Z')]]),
      now,
      TIMEZONE,
    );
    assert.equal(silentWithoutTicks.length, 1);

    const merged = new Map([['alert.dispatch', new Date('2026-07-21T12:09:30Z')]]);
    const silentWithTicks = findSilentSchedules([schedule], merged, now, TIMEZONE);
    assert.equal(silentWithTicks.length, 0);
  });
});
