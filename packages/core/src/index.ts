/**
 * @vantage/core — public surface.
 *
 * Domain logic: alert builder, Telegram formatter. Populated in later phases
 * with digest, thesis, rebalance, backtest.
 */

export const CORE_PACKAGE = '@vantage/core' as const;

// ---------------------------------------------------------------------------
// Phase 13 — observability (logger, self-alerts)
// ---------------------------------------------------------------------------

export {
  getLogger,
  componentLogger,
  logInfo,
  logWarn,
  logError,
  logDebug,
  __resetLogger,
  type Logger,
} from './logger.js';

export {
  sendSelfAlert,
  __resetSelfAlertState,
  type SelfAlertLevel,
  type SendSelfAlertResult,
} from './selfAlert.js';

export { buildAlertFromEvent, type BuildAlertOptions, type BuildAlertLogger } from './alert.js';

export {
  formatAlertForTelegram,
  formatInsightForTelegram,
  formatDigestForTelegram,
  formatCatalystAlertForTelegram,
  INSIGHT_ICONS,
  type FormatOptions,
  type FormatDigestOptions,
  type DigestKindLabel,
} from './formatter.js';

export {
  buildDigest,
  snapshotPortfolio,
  capValidator,
  DIGEST_WINDOWS,
  type DigestKind,
  type DigestResult,
  type BuildDigestOptions,
  type DigestLogger,
  type PortfolioSnapshot,
  type CapViolation,
  type BuySuggestionContext,
} from './digest.js';

export {
  evaluateThesis,
  aggregatePillarStatuses,
  type EvaluateThesisOptions,
  type ThesisEvalLogger,
  type PersistedPillar,
  type PersistedRiskFactor,
} from './thesis.js';

export {
  evaluateAllTheses,
  type EvaluateAllThesesOptions,
  type EvaluateAllThesesResult,
} from './thesisBatch.js';

// ---------------------------------------------------------------------------
// Phase 10 — rebalance engine
// ---------------------------------------------------------------------------

export {
  computeConcentration,
  checkCaps,
  type ConcentrationInput,
  type ConcentrationResult,
  type ConcentrationViolation,
  type PositionPct,
  type SectorPct,
  type CapViolationKind,
  type CheckCapsResult,
  type ComputeConcentrationOptions,
} from './rebalance/metrics.js';

export {
  sourceCandidates,
  type Candidate,
  type CandidateReason,
  type CandidateKind,
  type SourceCandidatesOptions,
} from './rebalance/candidates.js';

export {
  suggestRebalance,
  type SuggestRebalanceOptions,
  type SuggestRebalanceResult,
  type RebalanceTrigger,
  type RebalanceLogger,
} from './rebalance/engine.js';

export {
  computeShares,
  computeDollarsFromShares,
  MIN_FRACTIONAL_SHARES,
} from './rebalance/shares.js';

export {
  DefaultPriceOracle,
  configurePriceOracle,
  getPriceOracle,
  resetPriceOracle,
  type PriceOracle,
  type PriceResult,
  type PriceSource,
  type PriceCurrency,
  type PriceOracleDeps,
  type AdapterGetters,
  type ExchangeLookup,
} from './rebalance/priceOracle.js';

// Phase 16 — FX helpers (USD ↔ CAD via FRED DEXCAUS).
export {
  getUsdCadRate,
  convertToUsd,
  convertToUsdWithRate,
  getCachedFxRate,
  __resetFxCache,
  __setFredAdapter,
} from './fx.js';

export { percentagePointsToRatio } from './units.js';

// ---------------------------------------------------------------------------
// Phase 11 — backtest harness
// ---------------------------------------------------------------------------

export {
  runBacktest,
  type RunBacktestOptions,
  type RunBacktestLogger,
  type DailyBar,
  type BacktestConfig,
  type BacktestResult,
  type BacktestSnapshot,
  type BacktestTrade,
  type BacktestEquityPoint,
  type BacktestCaps,
  type BacktestStrategy,
  type SeedPosition,
  type BacktestPosition,
} from './backtest/engine.js';

export {
  equalWeightAllocate,
  trimToCapOnly,
  type EqualWeightAllocateInput,
  type TrimToCapOnlyInput,
} from './backtest/strategies.js';

export {
  computeDrawdown,
  computeCAGR,
  computeSharpeApprox,
  seriesToReturns,
} from './backtest/metrics.js';

// ---------------------------------------------------------------------------
// Phase 15 — Market discovery
// ---------------------------------------------------------------------------

export {
  newsVolumeScore,
  earningsSurpriseScore,
  insiderBuyScore,
  filingVelocityScore,
  priceMomentumScore,
  sentimentScore,
  computeDiscoveryScore,
  coerceWeights,
  DEFAULT_WEIGHTS,
  type DiscoveryWeights,
  type SignalBreakdown,
  type DiscoveryScoreResult,
  type ComputeDiscoveryScoreInput,
  type InsiderTxn,
  type Bar,
  type TickerMetricsLike,
} from './discover/signals.js';

export {
  evaluateRotationCaps,
  formatRotationPrice,
  scoreRotations,
  type RotationCapInput,
  type RotationCapResult,
  type ScoreRotationsOptions,
  type RotationCandidate,
  type RotationLogger,
} from './discover/rotation.js';

export {
  scoreHoldings,
  type ScoreHoldingsOptions,
  type ScoreHoldingsResult,
  type ScoreHoldingsLogger,
  type HoldingScoreRow,
} from './discover/scoreHoldings.js';

export {
  buildDiscoveryDigest,
  type BuildDiscoveryDigestOptions,
  type BuildDiscoveryDigestResult,
} from './digests/discovery.js';

export { formatDiscoveryDigestForTelegram } from './formatter.js';

export {
  computeVerdict,
  VERDICT_LEGEND,
  type Verdict,
  type VerdictKind,
  type VerdictTone,
  type VerdictInput,
  type VerdictInputHeld,
  type VerdictInputUnheld,
  type VerdictLegendEntry,
} from './discover/verdict.js';

// ---------------------------------------------------------------------------
// Phase 17 — Catalyst-driven discovery (foundations)
// ---------------------------------------------------------------------------

export {
  detectClusters,
  type ClusterEvent,
  type ClusterInsider,
  type Conviction,
  type DetectClustersOptions,
} from './discover/insiderCluster.js';

export {
  detectUpgrade,
  detectUpgrades,
  consensusFromRow,
  type UpgradeEvent,
  type Consensus,
  type DetectUpgradeOptions,
} from './discover/analystUpgrades.js';

export {
  qualityFilter,
  detectLotteryFromBars,
  createDefaultQualityFilterDeps,
  type QualityFilterResult,
  type QualityFilterDeps,
  type QualityFilterOptions,
  type QualityRejectReason,
  type LotteryDetectInput,
  type LotteryDetectResult,
} from './qualityGates.js';

// ---------------------------------------------------------------------------
// Phase 17 — Catalyst-driven buy engine
// ---------------------------------------------------------------------------

export {
  evaluateCatalysts,
  CATALYST_KINDS,
  type EvaluateCatalystsOptions,
  type CatalystResult,
  type CatalystLogger,
} from './catalyst/engine.js';

// ---------------------------------------------------------------------------
// Tax-aware account-placement engine
// ---------------------------------------------------------------------------

export {
  decidePlacement,
  loadAccountSummaries,
  loadStockProfile,
  type AccountType,
  type AccountSummary,
  type StockProfile,
  type PlacementDecision,
  type PlacementTradeoff,
} from './accounts/index.js';

// ---------------------------------------------------------------------------
// Portfolio aggregation (cross-account, ticker-grouped views)
// ---------------------------------------------------------------------------

export {
  aggregatePositionsByTicker,
  type AggregatedPosition,
  type RawPositionRow,
} from './portfolio/aggregate.js';

export {
  auditPortfolio,
  currenciesByTicker,
  nativeAmountToUsd,
  portfolioCurrency,
  usdAmountToCad,
  type PortfolioAudit,
  type PortfolioAuditBucket,
  type PortfolioAuditPosition,
  type PortfolioAuditTicker,
  type PortfolioCurrency,
} from './portfolio/valuation.js';

// ---------------------------------------------------------------------------
// Goals (curated security pool + engine — Wave 2 adds the engine)
// ---------------------------------------------------------------------------

export {
  CURATED_POOL,
  poolByCategories,
  findCurated,
  type CuratedSecurity,
} from './goals/securityPool.js';
export { MONTHLY_INCOME_TICKERS, isMonthlyIncomeTicker } from './goals/monthlyIncome.js';

export {
  horizonYears,
  deriveRiskTolerance,
  recommendAccount,
  recommendSecurities,
  computeProgress,
  detectConflicts,
  glideAllocation,
  placementForLinkedPosition,
  type GoalInput,
  type GoalType,
  type RiskTolerance,
  type LinkedPosition,
  type AccountRecommendation,
  type SecurityRecommendation,
  type GoalProgress,
  type GoalConflict,
  type GlideAllocation,
} from './goals/engine.js';

export { findFittingGoals, type GoalMatch } from './goals/loaders.js';

// Day-trade candidate scanner + the pure trade-plan math. Also re-exported from
// the `@vantage/core/goals` subpath; surfaced here so `scanDayTradeCandidates`
// is importable from the package root too.
export {
  scanDayTradeCandidates,
  computeTradePlan,
  computeAtrPct,
  computeRsi,
  scoreCandidate,
  selectActionableCandidates,
  selectDisplayPrice,
  type DayTradeCandidate,
  type TradePlan,
  type IntradayLevels,
  type DisplayPrice,
  type PriceSession,
} from './goals/dayTradeScanner.js';
