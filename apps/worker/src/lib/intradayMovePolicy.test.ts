import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hasFreshTradablePrint, MAX_INTRADAY_PRINT_AGE_MS } from './intradayMovePolicy.js';

const now = new Date('2026-07-17T15:00:00.000Z');

describe('intraday move print gate', () => {
  it('accepts a fresh positive print', () => {
    assert.equal(
      hasFreshTradablePrint(
        {
          timestamp: new Date(now.getTime() - 60_000),
          size: 10,
          dayVolume: 25_000,
        },
        now,
      ),
      true,
    );
  });

  it('rejects stale, zero-size, and zero-volume prints', () => {
    assert.equal(
      hasFreshTradablePrint(
        {
          timestamp: new Date(now.getTime() - MAX_INTRADAY_PRINT_AGE_MS - 1),
          size: 10,
          dayVolume: 25_000,
        },
        now,
      ),
      false,
    );
    assert.equal(hasFreshTradablePrint({ timestamp: now, size: 0, dayVolume: 25_000 }, now), false);
    assert.equal(hasFreshTradablePrint({ timestamp: now, size: 10, dayVolume: 0 }, now), false);
  });

  it('allows a fresh provider quote when size and volume are unavailable', () => {
    assert.equal(hasFreshTradablePrint({ timestamp: now, size: null, dayVolume: null }, now), true);
  });
});
