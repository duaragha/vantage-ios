/**
 * Digest builder — the shared pipeline for morning / evening / monthly / weekly
 * digests.
 *
 * A digest:
 *   1. Snapshots the portfolio + thesis state at the start (so mid-run writes
 *      don't leak into the context — cf. spec "User updates portfolio
 *      mid-digest" gotcha).
 *   2. Pulls a time-windowed article slice scoped to the snapshotted tickers.
 *   3. Applies the tier/satire filter (keyword pre-filter is satisfied by the
 *      ticker-scoped article query already).
 *   4. Dispatches to a kind-specific handler which builds the prompt + picks
 *      model + tools.
 *   5. Runs stripping (citations + caps where relevant) then writes Insight
 *      rows with `triggeredBy: 'digest:<kind>'`.
 *   6. Returns a prose summary (for the Telegram header) + the persisted
 *      insights.
 *
 * Every digest kind shares this scaffold so source-failure footers, snapshot
 * discipline, and prompt caching live in one place.
 */

import {
  prisma,
  type InsightKind,
  InsightStatus,
  Confidence,
  type Insight,
  type Article,
  type Position,
  type Thesis,
  type UserSettings,
  type Prisma,
} from '@vantage/db';
import {
  callClaude,
  buildSystemPrompt,
  buildPortfolioContext,
  stripUncitedCall,
  type CallClaudeParams,
  type ClaudeModel,
  type LlmPurpose,
  type ParsedToolCall,
  type Citation,
  type ToolDefinition,
  type AlertPayload,
  type ThesisUpdatePayload,
  type RebalanceSuggestionPayload,
  type BuySuggestionPayload,
} from '@vantage/llm';

import { buildMorningDigest } from './digests/morning.js';
import { buildEveningDigest } from './digests/evening.js';
import { buildMonthlyDigest } from './digests/monthly.js';
import { buildWeeklyDigest } from './digests/weekly.js';
import { suggestRebalance } from './rebalance/engine.js';

export type DigestKind = 'morning' | 'evening' | 'monthly' | 'weekly';

export interface DigestLogger {
  info?: (obj: unknown, msg?: string) => void;
  warn?: (obj: unknown, msg?: string) => void;
  error?: (obj: unknown, msg?: string) => void;
  debug?: (obj: unknown, msg?: string) => void;
}

export interface DigestTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
}

export interface DigestResult {
  kind: DigestKind;
  insights: Insight[];
  summary: string;
  /** Source names that failed or produced nothing during this window. */
  failedSources: string[];
  /** Token usage tallied across all LLM calls this digest made. */
  tokens: DigestTokenUsage;
  /** Captured LlmCall ids for traceability. */
  llmCallIds: number[];
}

export interface BuildDigestOptions {
  log?: DigestLogger;
  /** Override article window hours. Per-kind defaults listed in DIGEST_WINDOWS. */
  articleWindowHours?: number;
  /**
   * Injectable snapshot for tests — skips the DB snapshot step and uses this
   * instead. Normal callers should not pass this.
   */
  snapshotOverride?: PortfolioSnapshot;
}

/** Window sizes per spec Phase 8 task brief. */
export const DIGEST_WINDOWS: Record<DigestKind, number> = {
  morning: 14,
  evening: 8,
  weekly: 7 * 24,
  monthly: 30 * 24,
};

export interface PortfolioSnapshot {
  settings: UserSettings;
  positions: Array<Position & { thesis: Thesis | null }>;
  watchlistTickers: string[];
  /** Rendered markdown block (cached in system). */
  portfolioBlock: string;
  /** Captured at snapshot time — used everywhere downstream. */
  snapshotAt: Date;
}

export interface DigestContext {
  kind: DigestKind;
  snapshot: PortfolioSnapshot;
  windowHours: number;
  since: Date;
  articles: Article[];
  failedSources: string[];
  log: DigestLogger;
}

/**
 * Main entry point. Dispatches per-kind.
 */
export async function buildDigest(
  kind: DigestKind,
  opts: BuildDigestOptions = {},
): Promise<DigestResult> {
  const log = opts.log ?? defaultLog;
  const windowHours = opts.articleWindowHours ?? DIGEST_WINDOWS[kind];
  const snapshot = opts.snapshotOverride ?? (await snapshotPortfolio());
  const failedSources: string[] = [];

  const since = new Date(snapshot.snapshotAt.getTime() - windowHours * 3600_000);

  const articles = await fetchArticleWindow({
    since,
    tickers: [...snapshot.positions.map((p) => p.ticker), ...snapshot.watchlistTickers],
    failedSources,
    log,
  });

  const ctx: DigestContext = {
    kind,
    snapshot,
    windowHours,
    since,
    articles,
    failedSources,
    log,
  };

  log.info?.(
    {
      kind,
      windowHours,
      positions: snapshot.positions.length,
      watchlist: snapshot.watchlistTickers.length,
      articles: articles.length,
    },
    `[core/digest] building ${kind} digest`,
  );

  let result: DigestResult;
  switch (kind) {
    case 'morning':
      result = await buildMorningDigest(ctx);
      break;
    case 'evening':
      result = await buildEveningDigest(ctx);
      break;
    case 'monthly':
      result = await buildMonthlyDigest(ctx);
      break;
    case 'weekly':
      result = await buildWeeklyDigest(ctx);
      break;
  }

  // Phase 10 — conditionally append rebalance insights when caps are
  // currently violated. Only morning + evening digests trigger this (monthly
  // already runs buy suggestions end-to-end; weekly Opus has its own
  // cross-position synthesis).
  if (kind === 'morning' || kind === 'evening') {
    try {
      const rebal = await suggestRebalance({
        trigger: 'daily-digest',
        requireViolation: true,
        log,
      });
      if (rebal.insights.length > 0) {
        log.info?.(
          {
            kind,
            added: rebal.insights.length,
            violations: rebal.violations.length,
          },
          '[core/digest] appending cap-triggered rebalance insights',
        );
        result.insights = [...result.insights, ...rebal.insights];
        result.tokens = sumTokens(result.tokens, rebal.tokens);
        result.llmCallIds = [...result.llmCallIds, ...rebal.llmCallIds];
      }
    } catch (err) {
      log.warn?.(
        { err: err instanceof Error ? err.message : err, kind },
        '[core/digest] rebalance hook failed — continuing without it',
      );
    }
  }

  return result;
}

function sumTokens(a: DigestTokenUsage, b: DigestTokenUsage): DigestTokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
  };
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/**
 * Capture portfolio + thesis + settings + watchlist at the start of the run.
 * Downstream never re-queries position rows.
 */
export async function snapshotPortfolio(): Promise<PortfolioSnapshot> {
  const [settings, positions, watchlist, portfolioBlock] = await Promise.all([
    prisma.userSettings.findUnique({ where: { id: 1 } }),
    prisma.position.findMany({
      where: { closedAt: null },
      include: { thesis: true },
      orderBy: { ticker: 'asc' },
    }),
    prisma.watchlist.findMany({ orderBy: { ticker: 'asc' } }),
    buildPortfolioContext(),
  ]);

  if (!settings) {
    throw new Error('[core/digest] UserSettings (id=1) not found — run the seed script');
  }

  return {
    settings,
    positions,
    watchlistTickers: watchlist.map((w) => w.ticker),
    portfolioBlock,
    snapshotAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// Article window
// ---------------------------------------------------------------------------

interface FetchArticleWindowInput {
  since: Date;
  tickers: ReadonlyArray<string>;
  failedSources: string[];
  log: DigestLogger;
}

async function fetchArticleWindow(input: FetchArticleWindowInput): Promise<Article[]> {
  const { since, tickers, failedSources, log } = input;
  if (tickers.length === 0) return [];

  // Ticker-scoped article pull. satireBlocked=false already enforces the
  // satire blocklist from Phase 3's classifier; keyword pre-filter is
  // implicit because we filter on Article.tickers (which only gets populated
  // if ingestion's keyword filter matched).
  let articles: Article[] = [];
  try {
    articles = await prisma.article.findMany({
      where: {
        tickers: { hasSome: [...tickers] },
        satireBlocked: false,
        publishedAt: { gte: since },
      },
      orderBy: [{ publishedAt: 'desc' }, { sourceTier: 'asc' }],
      take: 80,
    });
  } catch (err) {
    log.error?.(
      { err: err instanceof Error ? err.message : err },
      '[core/digest] article window query failed',
    );
    failedSources.push('articles');
    return [];
  }

  // Surface which adapters produced nothing in this window. The Job summary
  // stashes which source a JobRun serviced; we infer source coverage by
  // checking which article.source values we saw. If any of the expected
  // sources are missing, flag them.
  const bySource = new Set(articles.map((a) => a.source));
  const EXPECTED = ['finnhub', 'edgar'];
  for (const s of EXPECTED) {
    if (!bySource.has(s)) {
      // Don't over-report: only flag as "failed" if the job ACTUALLY errored
      // recently. Otherwise a source just had no qualifying news, which is
      // fine. The contract per spec: "mark failed source in digest footer"
      // on actual rate-limit/network errors. We detect via recent JobRun.
      const jobName = sourceToJobName(s);
      if (jobName) {
        const failed = await hasRecentJobFailure(jobName, since);
        if (failed) failedSources.push(s);
      }
    }
  }

  return articles;
}

function sourceToJobName(source: string): string | null {
  switch (source) {
    case 'finnhub':
      return 'poll.news';
    case 'edgar':
      return 'poll.filings';
    default:
      return null;
  }
}

async function hasRecentJobFailure(jobName: string, since: Date): Promise<boolean> {
  const fail = await prisma.jobRun.findFirst({
    where: {
      name: jobName,
      status: 'failed',
      startedAt: { gte: since },
    },
    orderBy: { startedAt: 'desc' },
  });
  return Boolean(fail);
}

// ---------------------------------------------------------------------------
// Shared helpers — used by per-kind handlers
// ---------------------------------------------------------------------------

export interface RunDigestCallInput {
  ctx: DigestContext;
  model: ClaudeModel;
  purpose: LlmPurpose;
  tools: ToolDefinition[];
  systemAddendum: string;
  userText: string;
  maxTokens?: number;
}

export interface RunDigestCallResult {
  toolCalls: ParsedToolCall[];
  llmCallId: number;
  usage: DigestTokenUsage;
  errored: boolean;
}

/**
 * Thin wrapper around callClaude that builds the system+portfolio cached
 * prefix and swallows operational errors into the failedSources footer.
 *
 * The system block becomes `buildSystemPrompt() + "\n\n" + systemAddendum`
 * placed into Anthropic's `system` field as cached text, followed by the
 * portfolio block (also cached — the prefix-match rule means one breakpoint
 * on the portfolio block covers system+portfolio together).
 */
export async function runDigestCall(input: RunDigestCallInput): Promise<RunDigestCallResult> {
  const { ctx, model, purpose, tools, systemAddendum, userText, maxTokens } = input;

  const systemText = systemAddendum
    ? `${buildSystemPrompt()}\n\n${systemAddendum}`
    : buildSystemPrompt();

  const params: CallClaudeParams = {
    model,
    system: systemText,
    portfolio: ctx.snapshot.portfolioBlock,
    cacheSystem: true,
    cachePortfolio: true,
    messages: [{ role: 'user', content: userText }],
    tools,
    purpose,
    maxTokens: maxTokens ?? 4096,
  };

  try {
    const res = await callClaude(params);
    return {
      toolCalls: res.toolCalls,
      llmCallId: res.llmCallId,
      usage: res.usage,
      errored: false,
    };
  } catch (err) {
    ctx.log.error?.(
      {
        kind: ctx.kind,
        purpose,
        err: err instanceof Error ? err.message : err,
      },
      `[core/digest] ${purpose} call failed — continuing without insights`,
    );
    ctx.failedSources.push(`llm:${purpose}`);
    return {
      toolCalls: [],
      llmCallId: 0,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        cacheCreationTokens: 0,
      },
      errored: true,
    };
  }
}

/**
 * Render the shared "article window" section for a user message. Each entry
 * is `[articleId: N]` prefixed so the model can cite by id.
 */
export function renderArticleWindow(
  articles: ReadonlyArray<Article>,
  label: string,
  opts: { bodyCharLimit?: number } = {},
): string {
  const bodyCharLimit = opts.bodyCharLimit ?? 800;
  if (articles.length === 0) {
    return `# ${label}\n\n(No qualifying articles in this window.)\n`;
  }
  const lines: string[] = [
    `# ${label} (${articles.length} articles)`,
    '',
    'Every factual claim in your output must cite one of these by `articleId`. Prefer tier-1 over tier-2/tier-3 sources.',
    '',
  ];
  for (const a of articles) {
    const body = a.body ? a.body.slice(0, bodyCharLimit) : '';
    const trunc = a.body && a.body.length > bodyCharLimit ? ' …[truncated]' : '';
    const tickerTag = a.tickers.length > 0 ? ` · tickers: ${a.tickers.join(', ')}` : '';
    lines.push(
      `[articleId: ${a.id}] (tier ${a.sourceTier} · ${a.source}${a.domain ? ` · ${a.domain}` : ''}${tickerTag})`,
      `  ${a.publishedAt.toISOString()} — ${a.headline}`,
    );
    if (body) lines.push(`  ${body.replace(/\s+/g, ' ').trim()}${trunc}`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Build actionJson for a tool payload, normalized so the dashboard filter
 * (which reads actionJson.ticker and actionJson.type) works across all insight
 * kinds.
 */
export function buildActionJson(
  kind: 'alert' | 'rebalance' | 'buy' | 'thesis-update',
  payload: AlertPayload | RebalanceSuggestionPayload | BuySuggestionPayload | ThesisUpdatePayload,
  extras: Record<string, unknown> = {},
): Prisma.InputJsonValue {
  const out: Record<string, unknown> = { type: kind, ...extras };
  if ('ticker' in payload) out['ticker'] = payload.ticker;
  if ('targetTicker' in payload && payload.targetTicker) {
    out['targetTicker'] = payload.targetTicker;
  }
  if ('shares' in payload) out['shares'] = payload.shares;
  if ('action' in payload) out['action'] = payload.action;
  if ('newStatus' in payload) out['newStatus'] = payload.newStatus;
  if ('positionId' in payload) out['positionId'] = payload.positionId;
  if ('kind' in payload) out['alertKind'] = (payload as AlertPayload).kind;
  return out as Prisma.InputJsonValue;
}

export function toJsonCitations(citations: Citation[]): Prisma.InputJsonValue {
  return citations.map((c) => ({
    articleId: c.articleId,
    quote: c.quote,
  })) as Prisma.InputJsonValue;
}

/**
 * Citation-tier-aware confidence heuristic matching the alert builder.
 * When the payload already carries a confidence field (rebalance/buy), use
 * that as the ceiling and downgrade based on observed citation tiers.
 */
export function inferDigestConfidence(
  citations: Citation[],
  articles: ReadonlyArray<Article>,
  declared?: Confidence,
): Confidence {
  if (citations.length === 0) return Confidence.Low;
  const articleById = new Map<number, Article>();
  for (const a of articles) articleById.set(a.id, a);
  let hasTier1 = false;
  let allTier3 = true;
  for (const c of citations) {
    const a = articleById.get(c.articleId);
    const tier = a?.sourceTier ?? 2;
    if (tier === 1) hasTier1 = true;
    if (tier !== 3) allTier3 = false;
  }
  const observed: Confidence = hasTier1
    ? Confidence.High
    : allTier3
      ? Confidence.Low
      : Confidence.Medium;
  if (!declared) return observed;
  // Use the minimum of declared and observed — model's own self-assessment
  // can only downgrade below evidence-based ceiling.
  const rank: Record<Confidence, number> = {
    [Confidence.Low]: 0,
    [Confidence.Medium]: 1,
    [Confidence.High]: 2,
  };
  return rank[declared] < rank[observed] ? declared : observed;
}

/**
 * Persist a strip-validated tool call as an Insight row. Returns null when
 * the call fails citation validation.
 */
export async function persistInsightFromToolCall(input: {
  ctx: DigestContext;
  call: ParsedToolCall;
  triggeredBy: string;
  title: string;
  body: string;
  reasoning: string;
  kind: InsightKind;
  actionJson: Prisma.InputJsonValue;
  confidence: Confidence;
  clusterId?: string;
}): Promise<Insight> {
  const { call, triggeredBy, title, body, reasoning, kind, actionJson, confidence, clusterId } =
    input;

  // `emit_initial_thesis` / `emit_thesis_eval` don't carry top-level
  // citations and should never land here. Guard defensively so a future
  // refactor doesn't silently pass them through.
  const topLevelCitations =
    call.kind === 'emit_thesis_update' ||
    call.kind === 'emit_rebalance_suggestion' ||
    call.kind === 'emit_buy_suggestion' ||
    call.kind === 'emit_alert'
      ? call.payload.citations
      : [];

  return prisma.insight.create({
    data: {
      kind,
      title,
      body,
      reasoning,
      citations: toJsonCitations(topLevelCitations),
      actionJson,
      confidence,
      status: InsightStatus.New,
      triggeredBy,
      ...(clusterId ? { clusterId } : {}),
    },
  });
}

/**
 * Strip citations and drop the call if nothing remains. Returns null when the
 * call is fully dropped.
 */
export async function stripOrNull<T extends ParsedToolCall>(
  call: T,
  log: DigestLogger,
  ctxLabel: string,
): Promise<T | null> {
  const { call: stripped, droppedCitations } = await stripUncitedCall(call);
  if (droppedCitations.length > 0) {
    log.warn?.(
      {
        kind: call.kind,
        dropped: droppedCitations.length,
        ctxLabel,
      },
      '[core/digest] hallucinated citations stripped',
    );
  }
  if (!stripped) {
    log.warn?.(
      { kind: call.kind, ctxLabel },
      '[core/digest] all citations hallucinated — dropping tool call',
    );
    return null;
  }
  return stripped;
}

// ---------------------------------------------------------------------------
// Cap validator — used by monthly digest
// ---------------------------------------------------------------------------

export interface CapViolation {
  reason:
    | 'exceeds-budget'
    | 'single-position-cap'
    | 'sector-cap'
    | 'negative-shares'
    | 'no-price-snapshot';
  detail: string;
}

export interface BuySuggestionContext {
  pricePerShare: number;
  totalPortfolioValue: number;
  sector: string | null;
  sectorCurrentValue: number;
  tickerCurrentValue: number;
}

/**
 * Validate that a buy suggestion respects monthlyBudget, singlePositionCapPct,
 * and sectorCapPct. Returns null if the suggestion is legal, otherwise a
 * CapViolation describing the first failure.
 *
 * The budget check treats `monthlyBudget` as the cap on THIS suggestion's
 * dollar cost (not the sum across suggestions — the digest handler applies
 * remaining-budget tracking across multiple suggestions).
 */
export function capValidator(
  payload: BuySuggestionPayload,
  settings: UserSettings,
  buyCtx: BuySuggestionContext,
  remainingBudget: number,
): CapViolation | null {
  if (!Number.isFinite(payload.shares) || payload.shares <= 0) {
    return {
      reason: 'negative-shares',
      detail: `shares must be positive; got ${payload.shares}`,
    };
  }
  if (!Number.isFinite(buyCtx.pricePerShare) || buyCtx.pricePerShare <= 0) {
    return {
      reason: 'no-price-snapshot',
      detail: `no positive price snapshot for ${payload.ticker}`,
    };
  }

  const dollarCost = payload.shares * buyCtx.pricePerShare;
  const budget = Math.min(Number(settings.monthlyBudget), remainingBudget);
  if (dollarCost > budget + 0.01) {
    return {
      reason: 'exceeds-budget',
      detail: `buy cost $${dollarCost.toFixed(2)} USD > remaining budget $${budget.toFixed(2)} USD`,
    };
  }

  const postValue = buyCtx.totalPortfolioValue + dollarCost;
  if (postValue <= 0) return null; // Can't compute percentage on an empty book.

  const newTickerValue = buyCtx.tickerCurrentValue + dollarCost;
  const newTickerPct = (newTickerValue / postValue) * 100;
  if (newTickerPct > settings.singlePositionCapPct + 1e-6) {
    return {
      reason: 'single-position-cap',
      detail: `post-purchase ${payload.ticker} would be ${newTickerPct.toFixed(1)}% of portfolio (cap ${settings.singlePositionCapPct}%)`,
    };
  }

  if (buyCtx.sector) {
    const newSectorValue = buyCtx.sectorCurrentValue + dollarCost;
    const newSectorPct = (newSectorValue / postValue) * 100;
    if (newSectorPct > settings.sectorCapPct + 1e-6) {
      return {
        reason: 'sector-cap',
        detail: `post-purchase ${buyCtx.sector} sector would be ${newSectorPct.toFixed(1)}% of portfolio (cap ${settings.sectorCapPct}%)`,
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

const defaultLog: DigestLogger = {
  info: (obj, msg) => console.info(msg ?? '', obj),
  warn: (obj, msg) => console.warn(msg ?? '', obj),
  error: (obj, msg) => console.error(msg ?? '', obj),
  debug: (obj, msg) => console.debug(msg ?? '', obj),
};
