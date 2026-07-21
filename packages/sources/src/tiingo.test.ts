import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import JSZip from 'jszip';
import { TiingoAdapter } from './tiingo.js';

async function zipResponse(csv: string): Promise<Response> {
  const zip = new JSZip();
  zip.file('supported_tickers.csv', csv);
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  return new Response(bytes, { status: 200 });
}

describe('Tiingo supported ticker activity', () => {
  it('accepts current dated rows and legacy blank end dates while dropping stale symbols', async () => {
    const csv = [
      'ticker,exchange,assetType,priceCurrency,startDate,endDate',
      'CURRENT,NASDAQ,Stock,USD,2020-01-01,2026-07-17',
      'RECENT,NYSE,Stock,USD,2020-01-01,2026-07-10',
      'LEGACY,AMEX,Stock,USD,2020-01-01,',
      'DELISTED,NYSE,Stock,USD,2020-01-01,2025-12-31',
      'FUND,NASDAQ,ETF,USD,2020-01-01,2026-07-17',
    ].join('\n');
    const adapter = new TiingoAdapter({ apiKey: 'test' });
    const rows = await adapter.downloadSupportedTickers({
      fetchImpl: async () => zipResponse(csv),
    });

    assert.deepEqual(
      rows.map((row) => row.ticker),
      ['CURRENT', 'RECENT', 'LEGACY'],
    );
  });

  it('does not collapse a modern all-dated feed to an empty universe', async () => {
    const csv = [
      'ticker,exchange,assetType,priceCurrency,startDate,endDate',
      'AAPL,NASDAQ,Stock,USD,1980-12-12,2026-07-16',
      'MSFT,NASDAQ,Stock,USD,1986-03-13,2026-07-16',
    ].join('\n');
    const adapter = new TiingoAdapter({ apiKey: 'test' });
    const rows = await adapter.downloadSupportedTickers({
      fetchImpl: async () => zipResponse(csv),
    });

    assert.equal(rows.length, 2);
  });
});
