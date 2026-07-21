import assert from 'node:assert/strict';
import { beforeEach, it } from 'node:test';
import {
  __resetJobTicks,
  jobLivenessSnapshot,
  lastIdleSkipAt,
  lastJobTickAt,
  lastRealRunAt,
  recordIdleSkip,
  recordJobTick,
  recordRealRun,
} from './jobTicks.js';

beforeEach(() => {
  __resetJobTicks();
});

it('tracks ticks, idle skips and real runs independently', () => {
  const t1 = new Date('2026-07-21T12:00:00Z');
  const t2 = new Date('2026-07-21T12:00:30Z');
  recordJobTick('alert.dispatch', t1);
  recordIdleSkip('alert.dispatch', t1);
  recordRealRun('alert.dispatch', t2);

  assert.deepEqual(lastJobTickAt('alert.dispatch'), t1);
  assert.deepEqual(lastIdleSkipAt('alert.dispatch'), t1);
  assert.deepEqual(lastRealRunAt('alert.dispatch'), t2);
  assert.equal(lastJobTickAt('other.job'), null);
});

it('snapshots the newest liveness signal per job', () => {
  const older = new Date('2026-07-21T12:00:00Z');
  const newer = new Date('2026-07-21T12:05:00Z');
  recordJobTick('a', older);
  recordIdleSkip('a', newer);
  recordJobTick('b', newer);

  const snapshot = jobLivenessSnapshot();
  assert.deepEqual(snapshot.get('a'), newer);
  assert.deepEqual(snapshot.get('b'), newer);
});
