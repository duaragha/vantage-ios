import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { universeRefreshFailure } from '../jobs/pollTickerUniverse.js';

describe('ticker universe refresh completion policy', () => {
  it('treats any requested exchange returning zero rows as a failed job', () => {
    const failure = universeRefreshFailure([
      { exchange: 'US', fetched: 0, upserted: 0, source: 'tiingo' },
      { exchange: 'TO', fetched: 700, upserted: 700, source: 'twelvedata' },
    ]);

    assert.match(failure ?? '', /US \(zero symbols returned\)/);
  });

  it('preserves provider failure detail and accepts a complete refresh', () => {
    assert.match(
      universeRefreshFailure([
        {
          exchange: 'NE',
          fetched: 0,
          upserted: 0,
          source: 'twelvedata',
          reason: 'HTTP 503',
        },
      ]) ?? '',
      /NE \(HTTP 503\)/,
    );
    assert.equal(
      universeRefreshFailure([{ exchange: 'US', fetched: 8000, upserted: 8000, source: 'tiingo' }]),
      null,
    );
  });
});
