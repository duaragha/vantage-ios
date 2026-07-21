import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { requiresFullHistory } from './eodHistory.js';

describe('EOD history coverage', () => {
  const oldestNeeded = new Date('2025-01-01T00:00:00.000Z');

  it('backfills missing or undersized history', () => {
    assert.equal(requiresFullHistory(undefined, oldestNeeded, 7, 252), true);
    assert.equal(
      requiresFullHistory(
        { oldest: new Date('2025-01-02T00:00:00.000Z'), count: 251 },
        oldestNeeded,
        7,
        252,
      ),
      true,
    );
  });

  it('accepts a weekend-sized offset at the start of a complete window', () => {
    assert.equal(
      requiresFullHistory(
        { oldest: new Date('2025-01-06T00:00:00.000Z'), count: 260 },
        oldestNeeded,
        7,
        252,
      ),
      false,
    );
  });

  it('backfills when the oldest bar falls beyond the tolerance', () => {
    assert.equal(
      requiresFullHistory(
        { oldest: new Date('2025-01-09T00:00:00.000Z'), count: 300 },
        oldestNeeded,
        7,
        252,
      ),
      true,
    );
  });
});
