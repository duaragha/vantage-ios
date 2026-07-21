import assert from 'node:assert/strict';
import { it } from 'node:test';
import { normalizeQuoteRecord } from './yfinance.js';

it('preserves Canadian intraday range and volume from a Yahoo quote', () => {
  const quote = normalizeQuoteRecord('vdy.to', {
    regularMarketPrice: 58.42,
    regularMarketOpen: 57.9,
    regularMarketDayHigh: 58.5,
    regularMarketDayLow: 57.8,
    regularMarketVolume: 123_456,
    regularMarketPreviousClose: 57.75,
    regularMarketTime: 1_768_574_600,
    currency: 'CAD',
    exchange: 'TOR',
  });

  assert.equal(quote.ticker, 'VDY.TO');
  assert.equal(quote.dayOpen, 57.9);
  assert.equal(quote.dayHigh, 58.5);
  assert.equal(quote.dayLow, 57.8);
  assert.equal(quote.dayVolume, 123_456);
  assert.equal(quote.prevClose, 57.75);
  assert.equal(quote.currency, 'CAD');
});
