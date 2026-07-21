/**
 * Per-model pricing and cost calculation.
 *
 * Rates verified April 2026 via:
 * - https://platform.claude.com/docs/en/pricing
 * - https://platform.claude.com/docs/en/about-claude/models/overview
 * - ~/Documents/Projects/serena/knowledge/anthropic-sdk-typescript/{prompt-caching-2026.md,haiku-4-5.md,claude-sonnet-4-6-structured-outputs.md}
 *
 * Pricing units are USD per million tokens (USD / MTok).
 *
 * Cached input reads are billed at 0.1× base input (10% of normal input rate).
 * Callers pass cache_creation_input_tokens and cache_read_input_tokens
 * separately. Cache writes are billed at the 1.25× 5-minute ephemeral
 * multiplier; if we switch to 1-hour TTL, that multiplier must become 2×.
 * Anthropic web search is billed separately at $10 per 1,000 searches. Web
 * fetch currently has no per-request surcharge, so only search is added here.
 */

export type PricedModel = 'claude-haiku-4-5' | 'claude-sonnet-4-6' | 'claude-opus-4-7';

export interface ModelPricing {
  /** Base input price, USD per million tokens. */
  inputPerMTok: number;
  /** Output price, USD per million tokens. */
  outputPerMTok: number;
  /**
   * Cache-write multiplier. 1.25× for 5-minute ephemeral (default); 2× for 1h.
   * We use 5m throughout the project.
   */
  cacheWriteMultiplier: number;
  /** Cache-read multiplier — flat 0.1× for all current Claude models. */
  cacheReadMultiplier: number;
}

export const MODEL_PRICING: Record<PricedModel, ModelPricing> = {
  'claude-haiku-4-5': {
    inputPerMTok: 1.0,
    outputPerMTok: 5.0,
    cacheWriteMultiplier: 1.25,
    cacheReadMultiplier: 0.1,
  },
  'claude-sonnet-4-6': {
    inputPerMTok: 3.0,
    outputPerMTok: 15.0,
    cacheWriteMultiplier: 1.25,
    cacheReadMultiplier: 0.1,
  },
  // Opus 4.7: $5 input / $25 output per million (claude-api skill docs verified).
  'claude-opus-4-7': {
    inputPerMTok: 5.0,
    outputPerMTok: 25.0,
    cacheWriteMultiplier: 1.25,
    cacheReadMultiplier: 0.1,
  },
};

/** Anthropic server-side web-search surcharge: $10 / 1,000 searches. */
export const WEB_SEARCH_COST_USD = 0.01;

export interface CalculateCostInput {
  model: string;
  /** Uncached input tokens processed at full price. */
  inputTokens: number;
  /** Output tokens generated. */
  outputTokens: number;
  /**
   * Tokens served FROM cache on this request (cache hits), billed at 0.1×.
   * Maps to usage.cache_read_input_tokens.
   */
  cachedTokens?: number;
  /**
   * Tokens WRITTEN to cache on this request (cache misses that created a new
   * entry), billed at 1.25× for 5m TTL. Maps to usage.cache_creation_input_tokens.
   */
  cacheCreationTokens?: number;
  /** Maps to usage.server_tool_use.web_search_requests. */
  webSearchRequests?: number;
}

/**
 * Calculate cost in USD for a single Anthropic Messages API call.
 * Returns a floating-point dollar amount (not rounded — persist to Decimal).
 * Unknown model IDs are treated as Sonnet pricing (middle tier) to avoid
 * underbilling on an accidental unrecognized ID — logs a console warn so the
 * operator notices.
 */
export function calculateCost(input: CalculateCostInput): number {
  const {
    model,
    inputTokens,
    outputTokens,
    cachedTokens = 0,
    cacheCreationTokens = 0,
    webSearchRequests = 0,
  } = input;

  const pricing =
    MODEL_PRICING[model as PricedModel] ??
    (() => {
      console.warn(`[llm/cost] unknown model "${model}" — falling back to Sonnet pricing`);
      return MODEL_PRICING['claude-sonnet-4-6'];
    })();

  const inputCost = (inputTokens / 1_000_000) * pricing.inputPerMTok;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPerMTok;
  const cacheReadCost =
    (cachedTokens / 1_000_000) * pricing.inputPerMTok * pricing.cacheReadMultiplier;
  const cacheWriteCost =
    (cacheCreationTokens / 1_000_000) * pricing.inputPerMTok * pricing.cacheWriteMultiplier;

  const webSearchCost = webSearchRequests * WEB_SEARCH_COST_USD;

  return inputCost + outputCost + cacheReadCost + cacheWriteCost + webSearchCost;
}
