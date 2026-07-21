import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scheduledJobsHealthy, scheduleHealthStatus } from './scheduleHealth.js';

const TIMEZONE = 'America/Toronto';

describe('scheduleHealthStatus', () => {
  it('keeps a weekday daily job fresh through the weekend', () => {
    assert.equal(
      scheduleHealthStatus(
        '0 6 * * 1-5',
        new Date('2026-07-17T10:01:00Z'),
        new Date('2026-07-19T16:00:00Z'),
        TIMEZONE,
      ),
      'fresh',
    );
  });

  it('marks one missed frequent slot stale and two missed slots as an error', () => {
    const expression = '*/5 * * * 1-5';
    assert.equal(
      scheduleHealthStatus(
        expression,
        new Date('2026-07-17T14:00:10Z'),
        new Date('2026-07-17T14:05:30Z'),
        TIMEZONE,
      ),
      'stale',
    );
    assert.equal(
      scheduleHealthStatus(
        expression,
        new Date('2026-07-17T14:00:10Z'),
        new Date('2026-07-17T14:10:30Z'),
        TIMEZONE,
      ),
      'error',
    );
  });

  it('reports unknown until a job has succeeded at least once', () => {
    assert.equal(
      scheduleHealthStatus('0 9 1 * *', null, new Date('2026-07-17T14:00:00Z'), TIMEZONE),
      'unknown',
    );
    assert.equal(scheduledJobsHealthy(['fresh', 'running', 'stale', 'unknown']), true);
    assert.equal(scheduledJobsHealthy(['fresh', 'error']), false);
  });

  it('keeps a legitimate long-running job healthy between frequent cron slots', () => {
    assert.equal(
      scheduleHealthStatus(
        '*/5 * * * 1-5',
        new Date('2026-07-17T13:55:10Z'),
        new Date('2026-07-17T14:20:00Z'),
        TIMEZONE,
        new Date('2026-07-17T14:00:00Z'),
      ),
      'running',
    );
  });

  it('marks a running job unhealthy after the stuck-job ceiling', () => {
    assert.equal(
      scheduleHealthStatus(
        '*/5 * * * 1-5',
        new Date('2026-07-17T12:55:10Z'),
        new Date('2026-07-17T14:01:00Z'),
        TIMEZONE,
        new Date('2026-07-17T13:00:00Z'),
      ),
      'error',
    );
  });
});
