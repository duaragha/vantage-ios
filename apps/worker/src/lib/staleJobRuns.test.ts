import assert from 'node:assert/strict';
import { it } from 'node:test';
import { isOwnedByPreviousWorker } from './staleJobRuns.js';

it('claims every running row created before this single worker started', () => {
  const started = new Date('2026-07-17T02:00:00.000Z');
  assert.equal(isOwnedByPreviousWorker(new Date(started.getTime() - 1), started), true);
  assert.equal(isOwnedByPreviousWorker(started, started), false);
  assert.equal(isOwnedByPreviousWorker(new Date(started.getTime() + 1), started), false);
});
