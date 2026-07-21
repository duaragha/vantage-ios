/**
 * @vantage/sources
 *
 * Data source adapters + shared utilities for the ingestion pipeline.
 * Adapters return normalized data; they never write to Postgres — that's Phase 6's job.
 */

export type {
  SourceAdapter,
  NormalizedArticle,
  NormalizedEvent,
  NormalizedQuote,
  NormalizedBar,
} from './types.js';

export { RateLimiter, type RateLimiterOptions } from './rate-limit.js';

export {
  classifyDomain,
  isSatireDomain,
  extractDomain,
  TIER_1_DOMAINS,
  TIER_2_DOMAINS,
  SATIRE_DOMAINS,
  type ClassifyResult,
} from './classify.js';

export { clusterKey, normalize, roundTime } from './dedup.js';

export {
  FinnhubAdapter,
  AuthError as FinnhubAuthError,
  type FinnhubAdapterOptions,
  type FinnhubNewsItem,
  type FinnhubEarningsItem,
  type FinnhubQuote,
  type FinnhubProfile,
  type FinnhubRecommendation,
  type FinnhubInsiderTxn,
  type FinnhubSymbolItem,
  type FinnhubMarketNewsItem,
  type FinnhubNewsCategory,
  type FinnhubBasicFinancials,
  type NormalizedInsiderPurchase,
} from './finnhub.js';

export {
  AlpacaAdapter,
  AlpacaAuthError,
  type AlpacaAdapterOptions,
  type AlpacaSnapshot,
  type AlpacaStreamEvent,
  type AlpacaStreamHandler,
  type AlpacaSubscription,
  type BarTimeframe,
} from './alpaca.js';

export {
  EdgarAdapter,
  EdgarConfigError,
  getCompanyFacts,
  getTickerCikMap,
  type EdgarAdapterOptions,
  type EdgarFiling,
  type EdgarFormType,
  type FactPoint,
  type CompanyFactsResult,
  type TickerCikMap,
} from './edgar.js';

export {
  TiingoAdapter,
  TiingoAuthError,
  type TiingoAdapterOptions,
  type TiingoDailyPrice,
  type TiingoMeta,
  type TiingoSupportedTicker,
  type DownloadSupportedTickersOptions,
} from './tiingo.js';

export {
  TwelveDataAdapter,
  TwelveDataAuthError,
  type TwelveDataAdapterOptions,
  type TwelveDataExchange,
  type TwelveDataStock,
  type GetStocksOptions,
} from './twelvedata.js';

export {
  FredAdapter,
  FredAuthError,
  FRED_SERIES,
  type FredAdapterOptions,
  type FredObservation,
  type FredPoint,
  type FredShortcut,
} from './fred.js';

export {
  StocktwitsAdapter,
  type StocktwitsAdapterOptions,
  type StocktwitsArticle,
  type StocktwitsMessage,
} from './stocktwits.js';

export {
  YFinanceAdapter,
  type YFinanceQuote,
  type YFinanceProfile,
  type YFinanceFundamentals,
} from './yfinance.js';

export {
  normalizeSymbol,
  appendSuffix,
  deriveCurrency,
  resolveListingCurrency,
  isCaExchange,
  exchangeFlag,
  exchangeFromSymbol,
  CA_EXCHANGES,
  type ExchangeCode,
  type NormalizedSymbol,
} from './symbols.js';
