/**
 * Adapter singletons.
 *
 * Each adapter class holds its own rate limiter; re-constructing them per job
 * would wipe the bucket state and potentially blow past the per-minute quota.
 * Everything here is lazy — constructed on first use so missing env vars for
 * an unused source don't break jobs that don't need it.
 */

import {
  AlpacaAdapter,
  EdgarAdapter,
  FinnhubAdapter,
  FredAdapter,
  StocktwitsAdapter,
  TiingoAdapter,
  TwelveDataAdapter,
  YFinanceAdapter,
} from '@vantage/sources';

let _finnhub: FinnhubAdapter | null = null;
let _alpaca: AlpacaAdapter | null = null;
let _edgar: EdgarAdapter | null = null;
let _tiingo: TiingoAdapter | null = null;
let _twelveData: TwelveDataAdapter | null = null;
let _fred: FredAdapter | null = null;
let _stocktwits: StocktwitsAdapter | null = null;
let _yfinance: YFinanceAdapter | null = null;

export function getFinnhub(): FinnhubAdapter {
  if (!_finnhub) _finnhub = new FinnhubAdapter();
  return _finnhub;
}

export function getAlpaca(): AlpacaAdapter {
  if (!_alpaca) _alpaca = new AlpacaAdapter();
  return _alpaca;
}

export function getEdgar(): EdgarAdapter {
  if (!_edgar) _edgar = new EdgarAdapter();
  return _edgar;
}

export function getTiingo(): TiingoAdapter {
  if (!_tiingo) _tiingo = new TiingoAdapter();
  return _tiingo;
}

export function getTwelveData(): TwelveDataAdapter {
  if (!_twelveData) _twelveData = new TwelveDataAdapter();
  return _twelveData;
}

export function getFred(): FredAdapter {
  if (!_fred) _fred = new FredAdapter();
  return _fred;
}

/** Legacy StockTwits API access is opt-in because unapproved v2 calls return 403. */
export function getStocktwits(): StocktwitsAdapter | null {
  if (process.env['STOCKTWITS_ENABLED'] !== 'true') return null;
  if (!_stocktwits) _stocktwits = new StocktwitsAdapter();
  return _stocktwits;
}

export function getYFinance(): YFinanceAdapter {
  if (!_yfinance) _yfinance = new YFinanceAdapter();
  return _yfinance;
}
