import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveStoredPrice } from './prices.ts';

describe('resolveStoredPrice', () => {
  it('prefers a fresh persisted live quote and uses the latest prior close', () => {
    const now = new Date('2026-07-17T15:00:00Z');
    const result = resolveStoredPrice(
      'AAPL',
      { price: 210, fetchedAt: new Date('2026-07-17T14:59:00Z'), source: 'alpaca' },
      [
        { close: 200, date: new Date('2026-07-16T00:00:00Z') },
        { close: 190, date: new Date('2026-07-15T00:00:00Z') },
      ],
      now,
    );

    assert.equal(result?.price, 210);
    assert.equal(result?.previousClose, 200);
    assert.equal(result?.source, 'alpaca');
    assert.equal(result?.changePct, 5);
  });

  it('skips a same-day EOD bar when deriving previous close', () => {
    const now = new Date('2026-07-17T21:05:00Z');
    const result = resolveStoredPrice(
      'AAPL',
      { price: 210, fetchedAt: new Date('2026-07-17T21:04:00Z'), source: 'alpaca' },
      [
        { close: 210, date: new Date('2026-07-17T00:00:00Z') },
        { close: 200, date: new Date('2026-07-16T00:00:00Z') },
      ],
      now,
    );

    assert.equal(result?.previousClose, 200);
    assert.equal(result?.changePct, 5);
  });

  it('falls back to the latest two daily bars when the live quote is stale', () => {
    const result = resolveStoredPrice(
      'VDY.TO',
      { price: 60, fetchedAt: new Date('2026-07-16T15:00:00Z'), source: 'yfinance' },
      [
        { close: 61, date: new Date('2026-07-17T00:00:00Z') },
        { close: 60, date: new Date('2026-07-16T00:00:00Z') },
      ],
      new Date('2026-07-17T21:00:00Z'),
    );

    assert.equal(result?.price, 61);
    assert.equal(result?.previousClose, 60);
    assert.equal(result?.source, 'daily-bar');
    assert.ok(Math.abs((result?.changePct ?? 0) - 1.6666666667) < 1e-6);
  });
});
