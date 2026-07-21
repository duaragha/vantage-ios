/**
 * Anthropic client wrapper.
 *
 * Responsibilities:
 *   1. Singleton Anthropic SDK instance (getAnthropic()).
 *   2. Enforce operator stop-gates BEFORE spending money:
 *        - UserSettings.killSwitch → throw KillSwitchError
 *        - today's LlmCall spend vs UserSettings.dailySpendCapUsd → throw SpendCapError + flip killSwitch
 *        - this month's LlmCall spend vs UserSettings.monthlySpendCapUsd → same
 *        - when tickerContext.purpose === 'alert', per-ticker Insight cap check
 *   3. Apply prompt-caching breakpoints on system and/or portfolio blocks.
 *   4. Call the Messages API.
 *   5. Log LlmCall with model, input/output/cached/cache-creation tokens,
 *      cost, and purpose.
 *   6. Return the raw response + parsed tool calls.
 *
 * Prompt caching notes (verified against claude-api skill + knowledge base):
 * - Put static system text + portfolio context in the SYSTEM field, both as
 *   cache_control:ephemeral blocks. They render in order (tools → system →
 *   messages), so a breakpoint on the portfolio block caches tools+system
 *   together.
 * - 5-minute TTL is the default. The 1.25× write premium breaks even after
 *   the first cache read, and portfolio/system rarely mutate within 5 min.
 * - Minimum cacheable prefix is model-dependent: Sonnet 4.6 = 2048 tokens,
 *   Haiku 4.5 = 4096, Opus 4.7 = 4096. Below that threshold, cache_control is
 *   silently ignored with `cache_creation_input_tokens: 0`.
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  prisma,
  InsightKind,
  startOfZonedDay,
  startOfZonedMonth,
  type LlmCall,
  type Prisma,
} from '@vantage/db';
import { componentLogger, sendSelfAlert } from '@vantage/notify';
import { KillSwitchError, SpendCapError, TickerCapError } from './errors.js';
import { calculateCost } from './cost.js';
import { parseToolCalls, type ParsedToolCall } from './tools.js';
import type { ClaudeModel } from './tier.js';

const log = componentLogger('llm/client');

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _anthropic: Anthropic | null = null;

/**
 * Get the shared Anthropic SDK singleton. Reads ANTHROPIC_API_KEY from env.
 * Callers that need to inject a mock can override via setAnthropic() in tests.
 */
export function getAnthropic(): Anthropic {
  if (_anthropic) return _anthropic;
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set — refusing to construct Anthropic client');
  }
  _anthropic = new Anthropic({ apiKey });
  return _anthropic;
}

/** Test hook. */
export function setAnthropic(client: Anthropic | null): void {
  _anthropic = client;
}

// ---------------------------------------------------------------------------
// Params & return types
// ---------------------------------------------------------------------------

export type LlmPurpose =
  | 'relevance-filter'
  | 'digest-morning'
  | 'digest-evening'
  | 'digest-monthly'
  | 'digest-discovery'
  | 'weekly-deepdive'
  | 'alert'
  | 'thesis-eval'
  | 'rebalance'
  | 'chat'
  | 'bootstrap'
  | 'smoke'
  // Phase 17 — catalyst engine purposes. Tracked separately on the LlmCall
  // ledger so /ops can show the catalyst-pipeline spend.
  | 'catalyst-eval'
  | '8k-classify'
  | 'earnings-guidance';

export interface TickerContext {
  ticker: string;
  /**
   * Semantic purpose for this specific ticker scoping. Only 'alert' triggers
   * the per-ticker daily alert cap check (spec line 58: "Per-ticker event-alert
   * cap: 3/day").
   */
  purpose: 'alert' | 'thesis-eval' | 'rebalance' | 'chat';
}

export interface CallClaudeParams {
  model: ClaudeModel | string;
  /**
   * System prompt. Pass a single string (we'll place one cache_control on it
   * when cacheSystem is true), or an array of Anthropic.TextBlockParam for
   * fine-grained control.
   */
  system?: string | Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  // ToolUnion (vs Tool) so callers can also pass server-side tools like
  // web_search_20250305 — Anthropic's MessageCreateParams.tools is itself
  // typed as Array<ToolUnion>.
  tools?: Anthropic.ToolUnion[];
  tool_choice?: Anthropic.ToolChoice;
  /**
   * Portfolio-state block to be placed AFTER the static system prompt but
   * still inside the `system` field, so caching covers both. Kept separate so
   * callers can independently choose to cache it. Provide the rendered string
   * from buildPortfolioContext().
   */
  portfolio?: string;
  /** If true, place a cache_control:ephemeral breakpoint on the system block. */
  cacheSystem?: boolean;
  /**
   * If true, place a cache_control:ephemeral breakpoint on the portfolio
   * block. Note: per Anthropic's prefix-match rule, this breakpoint
   * implicitly covers the preceding system block too, so setting this
   * without cacheSystem is equivalent to "cache system+portfolio".
   */
  cachePortfolio?: boolean;
  /**
   * max_tokens for the response. Defaults to 16000 (SDK HTTP-timeout-safe;
   * see claude-api skill common pitfalls).
   */
  maxTokens?: number;
  /** Semantic purpose — persisted to LlmCall.purpose for spend auditing. */
  purpose: LlmPurpose;
  /** Optional — when purpose is 'alert', enforces per-ticker daily cap. */
  tickerContext?: TickerContext;
}

export interface CallClaudeResult {
  response: Anthropic.Message;
  toolCalls: ParsedToolCall[];
  costUsd: number;
  llmCallId: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    cacheCreationTokens: number;
    webSearchRequests: number;
  };
}

// ---------------------------------------------------------------------------
// Pre-flight checks
// ---------------------------------------------------------------------------

/**
 * Read UserSettings (id=1), enforce killSwitch, and return the settings row so
 * downstream checks can read the cap thresholds without re-querying.
 */
async function ensureKillSwitchOff(): Promise<{
  killSwitch: boolean;
  dailyCapUsd: number;
  monthlyCapUsd: number;
  perTickerDailyAlertCap: number;
  timezone: string;
}> {
  const settings = await prisma.userSettings.findUnique({ where: { id: 1 } });
  if (!settings) {
    throw new Error(
      'UserSettings row (id=1) not found — run the seed script before calling the LLM',
    );
  }
  if (settings.killSwitch) {
    // Debounced inside sendSelfAlert — we log at warn to avoid spam but still
    // audit the attempt so the /ops page shows a trail.
    log.warn({ event: 'kill-switch-block' }, 'LLM call blocked: killSwitch is ON');
    throw new KillSwitchError();
  }
  return {
    killSwitch: false,
    dailyCapUsd: Number(settings.dailySpendCapUsd),
    monthlyCapUsd: Number(settings.monthlySpendCapUsd),
    perTickerDailyAlertCap: settings.perTickerDailyAlertCap,
    timezone: settings.timezone,
  };
}

/**
 * Sum LlmCall.costUsd over a time window. We sum client-side to avoid the
 * Prisma Decimal → Float conversion in groupBy (Decimal aggregation support
 * in Prisma is fine, we just want a tight explicit path here).
 */
async function sumLlmSpendSince(since: Date): Promise<number> {
  const agg = await prisma.llmCall.aggregate({
    _sum: { costUsd: true },
    where: { createdAt: { gte: since } },
  });
  const sum = agg._sum.costUsd;
  return sum === null || sum === undefined ? 0 : Number(sum);
}

async function ensureSpendCaps(
  dailyCapUsd: number,
  monthlyCapUsd: number,
  timezone: string,
): Promise<void> {
  const now = new Date();
  const [todaySpend, monthSpend] = await Promise.all([
    sumLlmSpendSince(startOfZonedDay(now, timezone)),
    sumLlmSpendSince(startOfZonedMonth(now, timezone)),
  ]);

  if (todaySpend >= dailyCapUsd) {
    await tripKillSwitchAndAlert('daily', {
      todaySpend,
      monthSpend,
      dailyCapUsd,
      monthlyCapUsd,
    });
    throw new SpendCapError('daily', todaySpend, dailyCapUsd);
  }
  if (monthSpend >= monthlyCapUsd) {
    await tripKillSwitchAndAlert('monthly', {
      todaySpend,
      monthSpend,
      dailyCapUsd,
      monthlyCapUsd,
    });
    throw new SpendCapError('monthly', monthSpend, monthlyCapUsd);
  }
}

/**
 * Flip the kill switch + fire a critical self-alert. Kept separate so the
 * critical-alert path is obvious when auditing the code.
 */
async function tripKillSwitchAndAlert(
  scope: 'daily' | 'monthly',
  ctx: {
    todaySpend: number;
    monthSpend: number;
    dailyCapUsd: number;
    monthlyCapUsd: number;
  },
): Promise<void> {
  await prisma.userSettings.update({
    where: { id: 1 },
    data: { killSwitch: true },
  });
  log.error(
    { event: 'spend-cap-breach', scope, ...ctx },
    `spend cap breached (${scope}) — kill switch tripped`,
  );
  // Fire-and-forget — we don't want self-alert latency to gate the throw.
  void sendSelfAlert(
    'critical',
    `Spend cap breached (${scope}) — kill switch ON. All non-user LLM calls blocked.`,
    {
      scope,
      todaySpendUsd: Number(ctx.todaySpend.toFixed(4)),
      monthSpendUsd: Number(ctx.monthSpend.toFixed(4)),
      dailyCapUsd: ctx.dailyCapUsd,
      monthlyCapUsd: ctx.monthlyCapUsd,
    },
  );
}

async function ensurePerTickerAlertCap(
  ticker: string,
  perTickerDailyAlertCap: number,
  timezone: string,
): Promise<void> {
  const since = startOfZonedDay(new Date(), timezone);
  // Count Alert insights for this ticker created today.
  // Insight.actionJson schema stores { type, ticker, … } — we filter on that
  // JSON path, matching listInsightsByTicker in packages/db/src/insights.ts.
  const count = await prisma.insight.count({
    where: {
      kind: InsightKind.Alert,
      createdAt: { gte: since },
      actionJson: {
        path: ['ticker'],
        equals: ticker,
      },
    },
  });
  if (count >= perTickerDailyAlertCap) {
    throw new TickerCapError(ticker, count, perTickerDailyAlertCap);
  }
}

// ---------------------------------------------------------------------------
// System block assembly (with cache breakpoints)
// ---------------------------------------------------------------------------

function buildSystemBlocks(
  params: CallClaudeParams,
): Anthropic.TextBlockParam[] | string | undefined {
  const { system, portfolio, cacheSystem, cachePortfolio } = params;

  // No system content at all.
  if (system === undefined && portfolio === undefined) return undefined;

  // Simple case: bare string system, no portfolio, no caching. Pass through
  // as plain string to minimize request size.
  if (typeof system === 'string' && portfolio === undefined && !cacheSystem) {
    return system;
  }

  const blocks: Anthropic.TextBlockParam[] = [];

  if (system !== undefined) {
    if (typeof system === 'string') {
      const block: Anthropic.TextBlockParam = {
        type: 'text',
        text: system,
      };
      if (cacheSystem) {
        block.cache_control = { type: 'ephemeral' };
      }
      blocks.push(block);
    } else {
      // Caller-built array — respect as-is, optionally add cache on the last.
      for (const b of system) blocks.push(b);
      if (cacheSystem && blocks.length > 0) {
        const last = blocks[blocks.length - 1];
        if (last && !last.cache_control) {
          last.cache_control = { type: 'ephemeral' };
        }
      }
    }
  }

  if (portfolio !== undefined) {
    const block: Anthropic.TextBlockParam = {
      type: 'text',
      text: portfolio,
    };
    if (cachePortfolio) {
      block.cache_control = { type: 'ephemeral' };
    }
    blocks.push(block);
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Execute a Claude API call with all the wrapper plumbing: kill-switch check,
 * spend-cap check, optional per-ticker alert-cap check, prompt caching, and
 * persistent LlmCall audit log.
 */
export async function callClaude(params: CallClaudeParams): Promise<CallClaudeResult> {
  const { model, messages, tools, tool_choice, maxTokens, purpose, tickerContext } = params;

  // --- Pre-flight --------------------------------------------------------
  const { dailyCapUsd, monthlyCapUsd, perTickerDailyAlertCap, timezone } =
    await ensureKillSwitchOff();
  await ensureSpendCaps(dailyCapUsd, monthlyCapUsd, timezone);
  if (tickerContext && tickerContext.purpose === 'alert') {
    await ensurePerTickerAlertCap(tickerContext.ticker, perTickerDailyAlertCap, timezone);
  }

  // --- Build request -----------------------------------------------------
  const systemField = buildSystemBlocks(params);
  const requestBody: Anthropic.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: maxTokens ?? 16000,
    messages,
  };
  if (systemField !== undefined) requestBody.system = systemField;
  if (tools && tools.length > 0) requestBody.tools = tools;
  if (tool_choice) requestBody.tool_choice = tool_choice;

  // --- Execute ----------------------------------------------------------
  const client = getAnthropic();
  const response = await client.messages.create(requestBody);

  // --- Parse usage + cost ----------------------------------------------
  const usage = response.usage;
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cachedTokens = usage.cache_read_input_tokens ?? 0;
  const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
  const webSearchRequests = usage.server_tool_use?.web_search_requests ?? 0;

  const costUsd = calculateCost({
    model,
    inputTokens,
    outputTokens,
    cachedTokens,
    cacheCreationTokens,
    webSearchRequests,
  });

  // --- Persist LlmCall audit row ---------------------------------------
  const llmCall: LlmCall = await prisma.llmCall.create({
    data: {
      model,
      inputTokens,
      outputTokens,
      cachedTokens,
      cacheCreationTokens,
      webSearchRequests,
      costUsd: costUsd as unknown as Prisma.Decimal,
      purpose,
    },
  });

  // --- Parse tool calls (no citation stripping — caller invokes that) --
  const toolCalls = parseToolCalls(response);

  return {
    response,
    toolCalls,
    costUsd,
    llmCallId: llmCall.id,
    usage: {
      inputTokens,
      outputTokens,
      cachedTokens,
      cacheCreationTokens,
      webSearchRequests,
    },
  };
}
