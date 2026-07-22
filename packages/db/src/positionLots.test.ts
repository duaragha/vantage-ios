import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { aggregateActivePositionLots } from './positionLots.js';

describe('position purchase lots', () => {
  it('materializes total shares and share-weighted average cost', () => {
    const result = aggregateActivePositionLots([
      { shares: 10, costPerShare: 20 },
      { shares: 5, costPerShare: 32 },
    ]);

    assert.ok(result);
    assert.equal(result.shares.toNumber(), 15);
    assert.equal(result.avgCost.toNumber(), 24);
  });

  it('excludes disposed lots when a closed holding is later re-opened', () => {
    const result = aggregateActivePositionLots([
      { shares: 100, costPerShare: 8, disposedAt: new Date('2026-06-01T12:00:00Z') },
      { shares: 3.5, costPerShare: 14, disposedAt: null },
    ]);

    assert.ok(result);
    assert.equal(result.shares.toNumber(), 3.5);
    assert.equal(result.avgCost.toNumber(), 14);
  });

  it('returns null when no active acquisition remains', () => {
    assert.equal(
      aggregateActivePositionLots([
        { shares: 2, costPerShare: 10, disposedAt: new Date('2026-06-01T12:00:00Z') },
      ]),
      null,
    );
  });

  it('rejects invalid lot values before they can corrupt the snapshot', () => {
    assert.throws(() => aggregateActivePositionLots([{ shares: 0, costPerShare: 10 }]));
    assert.throws(() => aggregateActivePositionLots([{ shares: 1, costPerShare: -1 }]));
  });
});
