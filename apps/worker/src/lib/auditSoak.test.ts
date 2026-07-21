import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AUDIT_SOAK_DURATION_MS,
  assessAuditSoak,
  expectedAuditSoakSlots,
  isDailyOrLessFrequentSchedule,
  type AuditSoakRun,
  type AuditSoakSchedule,
} from './auditSoak.js';

const TIMEZONE = 'America/Toronto';
const STARTED_AT = new Date('2026-07-17T18:27:41.134Z');
const ENDS_AT = new Date(STARTED_AT.getTime() + AUDIT_SOAK_DURATION_MS);
const SCHEDULES: AuditSoakSchedule[] = [
  { name: 'poll.news', expr: '*/5 * * * 1-5' },
  { name: 'discover.compute', expr: '0 18 * * 1-5' },
  { name: 'poll.fundamentals', expr: '0 2 * * *' },
  { name: 'poll.tickerUniverse', expr: '0 6 * * 0' },
];

function success(id: number, name: string, startedAt: string): AuditSoakRun {
  const start = new Date(startedAt);
  return {
    id,
    name,
    status: 'succeeded',
    startedAt: start,
    endedAt: new Date(start.getTime() + 1_000),
    error: null,
  };
}

describe('audit soak verification', () => {
  it('selects daily schedules and enumerates their Toronto slots across the window', () => {
    assert.equal(isDailyOrLessFrequentSchedule('*/5 * * * 1-5', STARTED_AT, TIMEZONE), false);
    assert.equal(isDailyOrLessFrequentSchedule('0 2 * * *', STARTED_AT, TIMEZONE), true);

    assert.deepEqual(
      expectedAuditSoakSlots(SCHEDULES, STARTED_AT, ENDS_AT, TIMEZONE).map(
        (slot) => `${slot.name}:${slot.expectedAt.toISOString()}`,
      ),
      [
        'discover.compute:2026-07-17T22:00:00.000Z',
        'poll.fundamentals:2026-07-18T06:00:00.000Z',
        'poll.fundamentals:2026-07-19T06:00:00.000Z',
        'poll.tickerUniverse:2026-07-19T10:00:00.000Z',
      ],
    );
  });

  it('stays incomplete during the window and exposes failed or missing evidence', () => {
    const assessment = assessAuditSoak({
      schedules: SCHEDULES,
      runs: [
        success(1, 'discover.compute', '2026-07-17T22:00:00.100Z'),
        {
          id: 2,
          name: 'poll.news',
          status: 'failed',
          startedAt: new Date('2026-07-18T14:00:00.050Z'),
          endedAt: new Date('2026-07-18T14:00:01.000Z'),
          error: 'provider failed',
        },
      ],
      startedAt: STARTED_AT,
      now: new Date('2026-07-18T12:00:00.000Z'),
      timezone: TIMEZONE,
    });

    assert.equal(assessment.complete, false);
    assert.equal(assessment.elapsed, false);
    assert.equal(assessment.succeededSlots.length, 1);
    assert.equal(assessment.missingSlots.length, 1);
    assert.equal(assessment.pendingSlots.length, 2);
    assert.deepEqual(
      assessment.failedRuns.map((run) => run.id),
      [2],
    );
  });

  it('completes only after 48 hours with every slot successful and no failed runs', () => {
    const assessment = assessAuditSoak({
      schedules: SCHEDULES,
      runs: [
        success(1, 'discover.compute', '2026-07-17T22:00:00.100Z'),
        success(2, 'poll.fundamentals', '2026-07-18T06:00:00.100Z'),
        success(3, 'poll.fundamentals', '2026-07-19T06:00:00.100Z'),
        success(4, 'poll.tickerUniverse', '2026-07-19T10:00:00.100Z'),
      ],
      startedAt: STARTED_AT,
      now: new Date(ENDS_AT.getTime() + 1_000),
      timezone: TIMEZONE,
    });

    assert.equal(assessment.complete, true);
    assert.equal(assessment.elapsed, true);
    assert.equal(assessment.expectedSlots, 4);
    assert.equal(assessment.succeededSlots.length, 4);
    assert.deepEqual(assessment.pendingSlots, []);
    assert.deepEqual(assessment.missingSlots, []);
    assert.deepEqual(assessment.failedRuns, []);
  });
});
