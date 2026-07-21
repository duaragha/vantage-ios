import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { StocktwitsAdapter } from './stocktwits.js';

describe('StocktwitsAdapter access circuit breaker', () => {
  it('makes only one request after the API rejects access', async () => {
    let calls = 0;
    const adapter = new StocktwitsAdapter({
      fetchImpl: (async () => {
        calls += 1;
        return new Response('', { status: 403 });
      }) as typeof fetch,
    });

    assert.deepEqual(await adapter.getTickerStream('AAPL'), []);
    assert.equal(adapter.isAccessDisabled, true);
    assert.deepEqual(await adapter.getTickerStream('MSFT'), []);
    assert.equal(calls, 1);
  });

  it('keeps normal not-found responses enabled', async () => {
    let calls = 0;
    const adapter = new StocktwitsAdapter({
      fetchImpl: (async () => {
        calls += 1;
        return new Response('', { status: 404 });
      }) as typeof fetch,
    });

    assert.deepEqual(await adapter.getTickerStream('UNKNOWN1'), []);
    assert.equal(adapter.isAccessDisabled, false);
    assert.deepEqual(await adapter.getTickerStream('UNKNOWN2'), []);
    assert.equal(calls, 2);
  });
});
