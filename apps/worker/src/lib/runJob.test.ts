import assert from 'node:assert/strict';
import { it } from 'node:test';
import { runnerInstanceIdFromMetadata, sendJobFailureAlert } from './runJob.js';

it('alerts for a failed non-digest job', async () => {
  const calls: Array<{ level: string; message: string; context: Record<string, unknown> }> = [];
  const result = await sendJobFailureAlert(
    'poll.prices',
    '2026-07-16T22:00:00.000Z',
    'forced failure',
    async (level, message, context) => {
      calls.push({ level, message, context: context ?? {} });
      return { ok: true, messageId: 42 };
    },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    {
      level: 'error',
      message: 'Job failed: poll.prices',
      context: {
        job: 'poll.prices',
        bucket: '2026-07-16T22:00:00.000Z',
        error: 'forced failure',
      },
    },
  ]);
});

it('reads the runner owner only from valid JobRun metadata', () => {
  assert.equal(runnerInstanceIdFromMetadata({ runnerInstanceId: 'worker-a' }), 'worker-a');
  assert.equal(runnerInstanceIdFromMetadata({ runnerInstanceId: 42 }), null);
  assert.equal(runnerInstanceIdFromMetadata([]), null);
  assert.equal(runnerInstanceIdFromMetadata(null), null);
});

it('skips a precheck tick with no work — no JobRun row, liveness recorded', async () => {
  const { runJob } = await import('./runJob.js');
  const { __resetJobTicks, lastIdleSkipAt, lastJobTickAt, recordRealRun } = await import(
    './jobTicks.js'
  );
  __resetJobTicks();
  // Recent real run → the heartbeat does not force a DB run, so the skip
  // path below never touches the database.
  recordRealRun('test.precheck', new Date());

  let handlerRan = false;
  const result = await runJob({
    name: 'test.precheck',
    bucketSeconds: 30,
    precheck: async () => false,
    handler: async () => {
      handlerRan = true;
      return {};
    },
  });

  assert.equal(handlerRan, false);
  assert.deepEqual(result, { ran: false, jobRunId: null, result: null, error: null });
  assert.ok(lastJobTickAt('test.precheck'));
  assert.ok(lastIdleSkipAt('test.precheck'));
  __resetJobTicks();
});

it('heartbeatMs 0 disables the forced run — cadence gates skip even with no prior run', async () => {
  const { runJob } = await import('./runJob.js');
  const { __resetJobTicks } = await import('./jobTicks.js');
  __resetJobTicks();
  // No recordRealRun: with the default heartbeat this tick would be forced to
  // run for real (and hit the database); heartbeatMs 0 must skip instead.
  let handlerRan = false;
  const result = await runJob({
    name: 'test.cadence',
    bucketSeconds: 60,
    precheck: async () => false,
    heartbeatMs: 0,
    handler: async () => {
      handlerRan = true;
      return {};
    },
  });
  assert.equal(handlerRan, false);
  assert.deepEqual(result, { ran: false, jobRunId: null, result: null, error: null });
  __resetJobTicks();
});
