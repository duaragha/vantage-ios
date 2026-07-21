import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  deriveCurrency,
  isCaExchange,
  normalizeSymbol,
  resolveListingCurrency,
} from './symbols.js';

describe('listing exchange normalization', () => {
  it('recognizes provider and display aliases for Canadian exchanges', () => {
    for (const exchange of ['TO', 'TSX', 'XTSE', 'NEO', 'Cboe Canada', 'TSXV', 'TSX-V']) {
      assert.equal(isCaExchange(exchange), true, exchange);
      assert.equal(deriveCurrency(exchange), 'CAD', exchange);
    }
    assert.equal(isCaExchange('NASDAQ NMS'), false);
  });

  it('appends the canonical suffix for exchange aliases', () => {
    assert.equal(normalizeSymbol('SHOP', 'TSX').symbol, 'SHOP.TO');
    assert.equal(normalizeSymbol('HISA', 'NEO').symbol, 'HISA.NE');
    assert.equal(normalizeSymbol('PNG', 'TSXV').symbol, 'PNG.V');
  });

  it('lets a Canadian suffix repair stale USD metadata', () => {
    assert.equal(resolveListingCurrency('VDY.TO', 'USD', 'US'), 'CAD');
    assert.equal(resolveListingCurrency('SHOP', null, 'TSX'), 'CAD');
    assert.equal(resolveListingCurrency('AAPL', 'USD', 'NASDAQ'), 'USD');
  });
});
