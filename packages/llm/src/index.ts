/**
 * @vantage/llm — public surface.
 *
 * Anthropic client wrapper (prompt caching, tool-use structured outputs,
 * spend tracking, kill switch, per-ticker caps), plus the shared types and
 * tool definitions used by the digest/alert/thesis pipelines in packages/core.
 */

// Legacy type retained for backwards compatibility with early Phase-1 imports.
export type ModelTier = 'haiku' | 'sonnet' | 'opus';

// Client + wrapper params
export {
  getAnthropic,
  setAnthropic,
  callClaude,
  type CallClaudeParams,
  type CallClaudeResult,
  type LlmPurpose,
  type TickerContext,
} from './client.js';

// Typed errors
export {
  LlmWrapperError,
  KillSwitchError,
  SpendCapError,
  TickerCapError,
} from './errors.js';

// Model tiering
export {
  pickModel,
  HAIKU_MODEL,
  SONNET_MODEL,
  OPUS_MODEL,
  type LlmTask,
  type ClaudeModel,
} from './tier.js';

// Cost calculator + pricing
export {
  calculateCost,
  MODEL_PRICING,
  WEB_SEARCH_COST_USD,
  type PricedModel,
  type ModelPricing,
  type CalculateCostInput,
} from './cost.js';

// Tools + payload types
export {
  EMIT_THESIS_UPDATE_TOOL,
  EMIT_REBALANCE_SUGGESTION_TOOL,
  EMIT_BUY_SUGGESTION_TOOL,
  EMIT_ROTATION_SUGGESTION_TOOL,
  EMIT_ALERT_TOOL,
  EMIT_INITIAL_THESIS_TOOL,
  EMIT_THESIS_EVAL_TOOL,
  EXTRACT_EARNINGS_GUIDANCE_TOOL,
  CLASSIFY_8K_TOOL,
  ALL_TOOLS,
  TOOL_BY_NAME,
  parseToolCalls,
  parseThesisUpdate,
  parseRebalanceSuggestion,
  parseBuySuggestion,
  parseRotationSuggestion,
  parseAlert,
  parseInitialThesis,
  parseThesisEval,
  parseEarningsGuidance,
  parseEightKClassification,
  type ToolDefinition,
  type ToolName,
  type Citation,
  type ThesisStatus,
  type Confidence,
  type RebalanceAction,
  type ThesisUpdatePayload,
  type RebalanceSuggestionPayload,
  type BuySuggestionPayload,
  type RotationSuggestionPayload,
  type AlertPayload,
  type InitialThesisPayload,
  type InitialThesisPillar,
  type InitialThesisRiskFactor,
  type ThesisEvalPayload,
  type PillarEvaluation,
  type PillarEvaluationStatus,
  type PillarEvaluationEvidence,
  type RiskFactorUpdate,
  type ParsedToolCall,
  type EarningsGuidancePayload,
  type GuidanceDirection,
  type GuidanceConfidence,
  type EightKClassificationPayload,
  type EightKCategory,
  type EightKMarketDirection,
  type CatalystKind,
  type ConjunctionLevel,
} from './tools.js';

// Citation stripper
export {
  stripUncitedCall,
  stripUncitedCalls,
  defaultArticleExistsResolver,
  type ArticleExistsResolver,
  type StripOutcome,
} from './citation-stripper.js';

// Prompt builders
export {
  buildSystemPrompt,
  buildPortfolioContext,
  buildThesisContext,
  buildArticleWindow,
} from './prompts.js';

// Keyword pre-filter
export {
  hasTickerMention,
  type TickerSpec,
} from './keyword-filter.js';

// Phase 15 — ticker extraction (regex + Haiku fallback)
export {
  extractTickers,
  EXTRACT_TICKERS_TOOL,
  __resetTickerUniverseCache,
  type TickerExtractInput,
  type TickerExtractMethod,
  type TickerExtractResult,
  type ExtractTickersOptions,
} from './ticker-extract.js';

// Phase 17 — catalyst classifiers
export {
  classifyEightK,
  type ClassifyEightKInput,
  type ClassifyEightKResult,
  type ClassifyEightKArticle,
} from './classifiers/eightK.js';

export {
  extractEarningsGuidance,
  type ExtractGuidanceInput,
  type ExtractGuidanceResult,
  type GuidanceArticle,
} from './classifiers/earningsGuidance.js';
