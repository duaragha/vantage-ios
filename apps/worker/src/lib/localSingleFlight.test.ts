import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LocalSingleFlight } from './localSingleFlight.js';

describe('LocalSingleFlight', () => {
  it('allows one claim per name until release', () => {
    const registry = new LocalSingleFlight();

    assert.equal(registry.claim('discover.compute'), true);
    assert.equal(registry.claim('discover.compute'), false);
    assert.equal(registry.claim('poll.news'), true);

    registry.release('discover.compute');
    assert.equal(registry.claim('discover.compute'), true);
  });

  it('can safely release a name that is not claimed', () => {
    const registry = new LocalSingleFlight();

    registry.release('missing');
    assert.equal(registry.claim('missing'), true);
  });
});
