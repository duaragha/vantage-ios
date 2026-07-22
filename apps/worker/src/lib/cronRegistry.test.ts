import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Cron } from 'croner';
import { CRON_SPECS } from '../cron.js';

const EXPECTED_SCHEDULES = [
  ['poll.news', '*/5 * * * 1-5'],
  ['poll.filings', '*/5 * * * 1-5'],
  ['poll.prices', '* 4-19 * * 1-5'],
  ['poll.earnings', '*/15 * * * 1-5'],
  ['poll.eodHistory', '0 17 * * 1-5'],
  ['poll.macro', '0 6 * * 1-5'],
  ['poll.tickerUniverse', '0 6 * * 0'],
  ['poll.marketNews', '*/15 * * * 1-5'],
  ['discover.compute.cached', '30 10,13 * * 1-5'],
  ['discover.compute', '0 18 * * 1-5'],
  ['alert.dispatch', '*/30 * * * * *'],
  ['telegram.dispatch', '15,45 * * * * *'],
  ['app-notification.dispatch', '10,40 * * * * *'],
  ['digest.morning', '0 7 * * 1-5'],
  ['digest.evening', '30 16 * * 1-5'],
  ['digest.monthlyAllocation', '0 9 1 * *'],
  ['digest.weeklyDeepDive', '0 20 * * 0'],
  ['digest.discovery', '0 10 * * 6'],
  ['poll.insiders', '*/30 9-16 * * 1-5'],
  ['poll.analysts', '0 7 * * 1-5'],
  ['poll.fundamentals', '0 2 * * *'],
  ['backfill.profiles', '15 3 * * *'],
  ['quality.lottery', '30 1 * * *'],
  ['goals.snapshot', '0 3 * * *'],
  ['catalyst.run', '*/5 9-16 * * 1-5'],
  ['thesis.batch', '45 16 * * 1-5'],
  ['db.retention', '30 3 * * *'],
] as const;

it('transplants all 27 schedules into Croner without expression drift', () => {
  assert.deepEqual(
    CRON_SPECS.map(({ name, expr }) => [name, expr]),
    EXPECTED_SCHEDULES,
  );
  assert.equal(new Set(CRON_SPECS.map((spec) => spec.name)).size, 27);

  for (const spec of CRON_SPECS) {
    const parser = new Cron(spec.expr, {
      timezone: 'America/Toronto',
      paused: true,
    });
    assert.ok(parser.nextRun(new Date('2026-07-16T12:00:00Z')), spec.name);
    parser.stop();
  }
});
