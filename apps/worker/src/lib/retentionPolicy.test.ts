import assert from 'node:assert/strict';
import { it } from 'node:test';
import { CATALYST_DRAIN_HOURS, RETENTION_DAYS, retentionCutoffs } from './retentionPolicy.js';

const NOW = new Date('2026-07-21T07:30:00Z');
const DAY_MS = 24 * 3600 * 1000;

it('computes every cutoff from the configured windows', () => {
  const cutoffs = retentionCutoffs(NOW);
  assert.equal(
    cutoffs.jobRunSucceededBefore.getTime(),
    NOW.getTime() - RETENTION_DAYS.jobRunSucceeded * DAY_MS,
  );
  assert.equal(
    cutoffs.jobRunFailedBefore.getTime(),
    NOW.getTime() - RETENTION_DAYS.jobRunFailed * DAY_MS,
  );
  assert.equal(
    cutoffs.telegramSentBefore.getTime(),
    NOW.getTime() - RETENTION_DAYS.telegramSent * DAY_MS,
  );
  assert.equal(
    cutoffs.llmCallBefore.getTime(),
    NOW.getTime() - RETENTION_DAYS.llmCall * DAY_MS,
  );
  assert.equal(
    cutoffs.catalystEventDrainBefore.getTime(),
    NOW.getTime() - CATALYST_DRAIN_HOURS * 3600 * 1000,
  );
});

it('keeps failures around much longer than successes', () => {
  assert.ok(RETENTION_DAYS.jobRunFailed >= 3 * RETENTION_DAYS.jobRunSucceeded);
  assert.ok(RETENTION_DAYS.telegramDead >= RETENTION_DAYS.telegramSent);
});

it('keeps tier-3 articles beyond every read window that consumes them', () => {
  // Discovery sentiment reads 30d of articles; alert context reads 24h.
  assert.ok(RETENTION_DAYS.tier3Article >= 45);
  // Processed events outlive the 30d calendar/discovery badge windows.
  assert.ok(RETENTION_DAYS.marketEventProcessed >= 90);
});
