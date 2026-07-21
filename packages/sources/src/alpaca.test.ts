import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AlpacaAdapter } from './alpaca.js';

describe('AlpacaAdapter snapshots', () => {
  it('batches scanner symbols and normalizes every returned snapshot', async () => {
    const calls: URL[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      calls.push(url);
      const symbols = (url.searchParams.get('symbols') ?? '').split(',').filter(Boolean);
      const body = Object.fromEntries(
        symbols.map((ticker, index) => [
          ticker,
          {
            latestTrade: {
              p: 100 + index,
              s: 1,
              t: '2026-07-17T14:30:00.000Z',
            },
            dailyBar: {
              o: 99,
              h: 103,
              l: 98,
              c: 101,
              v: 10_000,
              t: '2026-07-17T04:00:00.000Z',
            },
            prevDailyBar: {
              o: 97,
              h: 100,
              l: 96,
              c: 98,
              v: 9_000,
              t: '2026-07-16T04:00:00.000Z',
            },
          },
        ]),
      );
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const adapter = new AlpacaAdapter({ keyId: 'test', secretKey: 'test', fetchImpl });
    const symbols = Array.from({ length: 101 }, (_, index) => `T${index}`);

    const snapshots = await adapter.getSnapshots(symbols);

    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.pathname, '/v2/stocks/snapshots');
    assert.equal(calls[0]?.searchParams.get('feed'), 'iex');
    assert.equal(calls[0]?.searchParams.get('symbols')?.split(',').length, 100);
    assert.equal(calls[1]?.searchParams.get('symbols'), 'T100');
    assert.equal(snapshots.size, 101);
    assert.deepEqual(snapshots.get('T0'), {
      ticker: 'T0',
      last: 100,
      lastTradeSize: 1,
      dayOpen: 99,
      dayHigh: 103,
      dayLow: 98,
      dayClose: 101,
      dayVolume: 10_000,
      prevClose: 98,
      timestamp: new Date('2026-07-17T14:30:00.000Z'),
      source: 'alpaca',
    });
  });

  it('deduplicates symbols and omits unusable responses', async () => {
    let requested = '';
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      requested = url.searchParams.get('symbols') ?? '';
      return new Response(
        JSON.stringify({
          AAPL: { dailyBar: { o: 190, h: 195, l: 189, c: 194, v: 1, t: '2026-07-17' } },
          EMPTY: {},
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    const adapter = new AlpacaAdapter({ keyId: 'test', secretKey: 'test', fetchImpl });

    const snapshots = await adapter.getSnapshots(['aapl', 'AAPL', 'empty', '']);

    assert.equal(requested, 'AAPL,EMPTY');
    assert.equal(snapshots.size, 1);
    assert.equal(snapshots.get('AAPL')?.dayClose, 194);
    assert.equal(snapshots.has('EMPTY'), false);
  });
});

describe('AlpacaAdapter multi-symbol bars', () => {
  it('deduplicates, batches, follows pagination, and normalizes daily bars', async () => {
    const calls: URL[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      calls.push(url);
      const symbols = (url.searchParams.get('symbols') ?? '').split(',').filter(Boolean);
      const pageToken = url.searchParams.get('page_token');
      const first = symbols[0] ?? 'EMPTY';
      const last = symbols[symbols.length - 1] ?? first;
      const body = pageToken
        ? {
            bars: {
              [last]: [wireBar('2026-07-17T04:00:00.000Z', 102)],
            },
            next_page_token: null,
          }
        : {
            bars: {
              [first]: [wireBar('2026-07-16T04:00:00.000Z', 100)],
            },
            next_page_token: symbols.length === 100 ? 'next-page' : null,
          };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const adapter = new AlpacaAdapter({ keyId: 'test', secretKey: 'test', fetchImpl });
    const symbols = [...Array.from({ length: 101 }, (_, index) => `T${index}`), 't0'];

    const bars = await adapter.getMultiBars(
      symbols,
      '1Day',
      new Date('2026-07-01T00:00:00.000Z'),
      new Date('2026-07-18T00:00:00.000Z'),
    );

    assert.equal(calls.length, 3);
    assert.equal(calls[0]?.pathname, '/v2/stocks/bars');
    assert.equal(calls[0]?.searchParams.get('symbols')?.split(',').length, 100);
    assert.equal(calls[0]?.searchParams.get('limit'), '10000');
    assert.equal(calls[0]?.searchParams.get('adjustment'), 'all');
    assert.equal(calls[0]?.searchParams.get('feed'), 'iex');
    assert.equal(calls[1]?.searchParams.get('page_token'), 'next-page');
    assert.equal(calls[2]?.searchParams.get('symbols'), 'T100');
    assert.equal(bars.get('T0')?.[0]?.close, 100);
    assert.equal(bars.get('T99')?.[0]?.close, 102);
    assert.equal(bars.get('T100')?.[0]?.source, 'alpaca');
  });

  it('stops when Alpaca repeats a page token', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(
        JSON.stringify({
          bars: { AAPL: [wireBar('2026-07-17T04:00:00.000Z', 200)] },
          next_page_token: 'stuck-token',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    const adapter = new AlpacaAdapter({ keyId: 'test', secretKey: 'test', fetchImpl });

    const bars = await adapter.getMultiBars(
      ['AAPL'],
      '1Day',
      new Date('2026-07-01T00:00:00.000Z'),
      new Date('2026-07-18T00:00:00.000Z'),
    );

    assert.equal(calls, 2);
    assert.equal(bars.get('AAPL')?.length, 2);
  });
});

function wireBar(timestamp: string, close: number) {
  return {
    t: timestamp,
    o: close - 1,
    h: close + 1,
    l: close - 2,
    c: close,
    v: 10_000,
  };
}
