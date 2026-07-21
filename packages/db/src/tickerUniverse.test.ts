import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildTickerUniverseUpdate, inferTickerCurrency } from './tickerUniverse.js';

describe('ticker universe refresh merge contract', () => {
  it('preserves enrichment fields that the source omitted', () => {
    const update = buildTickerUniverseUpdate(
      {
        symbol: 'AAPL',
        name: 'Apple Inc.',
        exchange: 'NASDAQ',
        currency: 'USD',
        symbolRaw: 'AAPL',
      },
      new Date('2026-07-17T12:00:00Z'),
    );

    assert.equal('cik' in update, false);
    assert.equal('sector' in update, false);
    assert.equal('marketCapUsd' in update, false);
    assert.equal('aliases' in update, false);
    assert.equal('currency' in update, true);
    assert.equal('symbolRaw' in update, true);
  });

  it('preserves listing identity fields omitted by an enrichment-only refresh', () => {
    const update = buildTickerUniverseUpdate(
      { symbol: 'VDY.TO', name: 'Vanguard Canadian High Dividend', exchange: 'TO' },
      new Date('2026-07-17T12:00:00Z'),
    );
    assert.equal('currency' in update, false);
    assert.equal('symbolRaw' in update, false);
  });

  it('honors explicit clears when a caller supplies null or an empty list', () => {
    const update = buildTickerUniverseUpdate(
      {
        symbol: 'TEST',
        name: 'Test Corp',
        exchange: 'US',
        cik: null,
        sector: null,
        marketCapUsd: null,
        aliases: [],
      },
      new Date('2026-07-17T12:00:00Z'),
    );

    assert.equal(update.cik, null);
    assert.equal(update.sector, null);
    assert.equal(update.marketCapUsd, null);
    assert.deepEqual(update.aliases, []);
  });

  it('infers Canadian currency from either the symbol suffix or exchange alias', () => {
    assert.equal(inferTickerCurrency('VDY.TO', 'US'), 'CAD');
    assert.equal(inferTickerCurrency('SHOP', 'TSX'), 'CAD');
    assert.equal(inferTickerCurrency('AAPL', 'NASDAQ'), 'USD');
  });
});
