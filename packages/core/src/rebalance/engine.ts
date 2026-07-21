/**
 * Rebalance engine.
 *
 * Entry: `suggestRebalance(opts?)`. Produces zero or more Insight rows with
 * kind=Rebalance (trim/rotate/exit) or kind=BuySuggestion (fresh buys),
 * persisted with citations + confidence, and returns them to the caller.
 *
 * Steps (matching the spec Phase 10 brief):
 *   (a) Pull Positions + Settings + latest prices via the price oracle
 *   (b) Compute concentration + check caps
 *   (c) Early exit when no violations AND no interesting candidates
 *   (d) Build Sonnet prompt — portfolio snapshot, violations, candidates,
 *       recent relevant news window for held + candidate tickers,
 *       current cash (monthlyBudget)
 *   (e) Call Sonnet with BOTH emit_rebalance_suggestion and
 *       emit_buy_suggestion tools available
 *   (f) For each tool call:
 *         - strip uncited
 *         - validate caps (buy via capValidator; rebalance via purpose-aware
 *           check — trims/exits/rotates away from an offender are allowed
 *           even if the "cap" equation fails because they REDUCE concentration)
 *         - check PassCooldown for the relevant actionKind
 *         - share-count sanity (≥ 0.01)
 *   (g) Don't double-write: if an Insight with same action+ticker was
 *       written in the last 24h, skip (spec rule)
 *   (h) Return persisted insights
 *
 * Pure-enough-for-tests: callers can inject `priceOracle` + `now`, skip the
 * Sonnet call by providing `callClaudeFn`, etc. Default wiring goes through
 * the real adapters via the module-level singletons.
 */

import {
  prisma,
  InsightKind,
  InsightStatus,
  Confidence,
  isPassCooldownActive,
  type Insight,
  type Position,
  type Prisma,
  type UserSettings,
} from '@vantage/db';
import {
  callClaude as defaultCallClaude,
  SONNET_MODEL,
  buildSystemPrompt,
  buildPortfolioContext,
  stripUncitedCall,
  EMIT_REBALANCE_SUGGESTION_TOOL,
  EMIT_BUY_SUGGESTION_TOOL,
  EMIT_ROTATION_SUGGESTION_TOOL,
  type CallClaudeParams,
  type CallClaudeResult,
  type ParsedToolCall,
  type Citation,
  type BuySuggestionPayload,
  type RebalanceSuggestionPayload,
  type RotationSuggestionPayload,
} from '@vantage/llm';

import {
  computeConcentration,
  checkCaps,
  type ConcentrationResult,
  type ConcentrationViolation,
} from './metrics.js';
import { sourceCandidates, type Candidate } from './candidates.js';
import { getPriceOracle, type PriceOracle, type PriceResult } from './priceOracle.js';
import { MIN_FRACTIONAL_SHARES } from './shares.js';
import { capValidator, type BuySuggestionContext } from '../digest.js';
import { evaluateRotationCaps, scoreRotations } from '../discover/rotation.js';
import {
  decidePlacement,
  type AccountType as PlacementAccountType,
} from '../accounts/placement.js';
import { loadAccountSummaries, loadStockProfile } from '../accounts/loaders.js';
import { deriveRiskTolerance, recommendSecurities, type GoalInput } from '../goals/engine.js';
import { loadTopDiscoveryPicks } from '../goals/loaders.js';
import { getUsdCadRate } from '../fx.js';
import {
  currenciesByTicker,
  nativeAmountToUsd,
  usdAmountToCad,
  type PortfolioCurrency,
} from '../portfolio/valuation.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RebalanceTrigger = 'daily-digest' | 'manual' | 'monthly-allocation';

export interface RebalanceLogger {
  info?: (obj: unknown, msg?: string) => void;
  warn?: (obj: unknown, msg?: string) => void;
  error?: (obj: unknown, msg?: string) => void;
  debug?: (obj: unknown, msg?: string) => void;
}

export interface SuggestRebalanceOptions {
  trigger?: RebalanceTrigger;
  log?: RebalanceLogger;
  /** Override the price oracle for tests. */
  priceOracle?: PriceOracle;
  /** Override the Claude call (tests). */
  callClaudeFn?: (params: CallClaudeParams) => Promise<CallClaudeResult>;
  /** Article window (hours) for context rendering. Default 72. */
  articleWindowHours?: number;
  /** Max articles included in the prompt. Default 30. */
  maxArticles?: number;
  /** Per-ticker max recent articles. Default 3. */
  perTickerMaxArticles?: number;
  /** For tests: clock override. */
  now?: () => Date;
  /**
   * Short-circuit when no violations and no candidates. Default true.
   * The daily-digest trigger can set this to false-ish via `onlyIfViolations`
   * upstream — we keep this flag here for clarity.
   */
  returnEarlyWhenClean?: boolean;
  /**
   * If true, only run when caps are currently violated. Used by the daily
   * digest conditional path to avoid burning tokens on a clean portfolio.
   * Default false.
   */
  requireViolation?: boolean;
}

export interface SuggestRebalanceResult {
  insights: Insight[];
  /** Portfolio concentration snapshot. */
  concentration: ConcentrationResult;
  /** Cap violations detected. */
  violations: ConcentrationViolation[];
  /** Candidates sourced (post-cooldown filter). */
  candidates: Candidate[];
  /** True when the engine skipped the LLM call entirely. */
  skipped: boolean;
  /** Short reason when skipped. */
  skipReason?: string;
  tokens: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    cacheCreationTokens: number;
  };
  llmCallIds: number[];
}

interface ReplacementOption {
  trimTicker: string;
  buyTicker: string;
  source: 'goal' | 'discovery';
  reason: string;
  scoreDelta: number;
  goalId: number | null;
}

export type ReplacementSearchState = 'found' | 'none-cleared' | 'source-unavailable';

interface ReplacementSearchResult {
  options: ReplacementOption[];
  stateByTrim: Map<string, ReplacementSearchState>;
}

type GoalPositionWithGoal = Prisma.GoalPositionGetPayload<{
  include: {
    goal: { include: { account: true } };
    position: true;
  };
}>;

const DISCOVERY_REPLACEMENT_MAX_AGE_MS = 72 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export async function suggestRebalance(
  opts: SuggestRebalanceOptions = {},
): Promise<SuggestRebalanceResult> {
  const log = opts.log ?? defaultLog;
  const trigger = opts.trigger ?? 'manual';
  const articleWindowHours = opts.articleWindowHours ?? 72;
  const maxArticles = opts.maxArticles ?? 30;
  const perTickerMaxArticles = opts.perTickerMaxArticles ?? 3;
  const oracle = opts.priceOracle ?? getPriceOracle();
  const callClaudeFn = opts.callClaudeFn ?? defaultCallClaude;
  const now = opts.now ?? (() => new Date());

  // ---- (a) snapshot ------------------------------------------------------
  const [positions, settings] = await Promise.all([
    prisma.position.findMany({
      where: { closedAt: null },
      orderBy: { ticker: 'asc' },
    }),
    prisma.userSettings.findUnique({ where: { id: 1 } }),
  ]);
  if (!settings) {
    throw new Error('[rebalance/engine] UserSettings (id=1) not found — run seed');
  }

  const heldTickers = positions.map((p) => p.ticker.toUpperCase());
  const [heldPriceMap, usdCadRate] = await Promise.all([
    fetchPrices(oracle, heldTickers, log),
    getUsdCadRate(),
  ]);

  // ---- (b) concentration + caps -----------------------------------------
  const concentration = computeConcentration({
    positions,
    prices: toPriceRecord(heldPriceMap),
    currencies: currenciesByTicker(positions),
    usdCadRate,
  });
  const { violations } = checkCaps(concentration, settings);

  // ---- (c) candidate sourcing -------------------------------------------
  const candidates = await sourceCandidates({
    kind: trigger === 'monthly-allocation' ? 'monthly-allocation' : 'rebalance-suggest',
    positions,
    settings,
    concentration,
    violations,
    logger: log,
  });

  const capTrimTickers = selectCapTrimTickers(concentration, violations);
  const replacementSearch = await buildReplacementOptions({
    positions,
    settings,
    oracle,
    capTrimTickers,
    concentration,
    violations,
    log,
    now: now(),
  });
  const replacementOptions = replacementSearch.options;

  // Resolve prices for unheld candidate tickers too — the buy validator
  // rejects suggestions without a price snapshot, so we don't want the model
  // to waste tokens on a buy we can't size.
  const candidateOnly = [
    ...candidates.map((candidate) => candidate.ticker),
    ...replacementOptions.map((option) => option.buyTicker),
  ].filter((ticker) => !heldTickers.includes(ticker));
  const candidatePriceMap = await fetchPrices(oracle, candidateOnly, log);
  const priceMap = new Map<string, PriceResult | null>([...heldPriceMap, ...candidatePriceMap]);

  const returnEarly = opts.returnEarlyWhenClean !== false;
  if (opts.requireViolation === true && violations.length === 0) {
    log.info?.(
      { trigger, candidates: candidates.length },
      '[rebalance/engine] requireViolation=true and portfolio is clean — skipping',
    );
    return emptyResult(concentration, violations, candidates, 'no-violations');
  }
  if (returnEarly && violations.length === 0 && candidates.length === 0) {
    log.info?.({ trigger }, '[rebalance/engine] no violations and no candidates — skipping LLM');
    return emptyResult(concentration, violations, candidates, 'nothing-to-do');
  }

  // ---- (d) build prompt --------------------------------------------------
  const articles = await fetchArticleWindow({
    tickers: [...heldTickers, ...candidates.map((c) => c.ticker)],
    windowHours: articleWindowHours,
    maxArticles,
    perTickerMax: perTickerMaxArticles,
  });

  const [systemText, portfolioText] = await Promise.all([
    Promise.resolve(buildSystemPrompt()),
    buildPortfolioContext(),
  ]);
  const systemAddendum = buildSystemAddendum(settings);
  const userText = renderUserPrompt({
    trigger,
    settings,
    concentration,
    violations,
    candidates,
    replacementOptions,
    replacementStateByTrim: replacementSearch.stateByTrim,
    priceMap,
    articles,
    articleWindowHours,
  });

  // ---- (e) call Sonnet ---------------------------------------------------
  let toolCalls: ParsedToolCall[] = [];
  let usage: SuggestRebalanceResult['tokens'] = {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheCreationTokens: 0,
  };
  let llmCallId = 0;
  try {
    const res = await callClaudeFn({
      model: SONNET_MODEL,
      system: `${systemText}\n\n${systemAddendum}`,
      portfolio: portfolioText,
      cacheSystem: true,
      cachePortfolio: true,
      messages: [{ role: 'user', content: userText }],
      tools: [
        EMIT_REBALANCE_SUGGESTION_TOOL,
        EMIT_ROTATION_SUGGESTION_TOOL,
        EMIT_BUY_SUGGESTION_TOOL,
      ],
      purpose: 'rebalance',
      maxTokens: 4096,
    });
    toolCalls = res.toolCalls;
    usage = res.usage;
    llmCallId = res.llmCallId;
  } catch (err) {
    log.error?.(
      { err: err instanceof Error ? err.message : err },
      '[rebalance/engine] Sonnet call failed',
    );
    return {
      insights: [],
      concentration,
      violations,
      candidates,
      skipped: true,
      skipReason: 'llm-failed',
      tokens: usage,
      llmCallIds: [],
    };
  }

  // ---- (f + g) validate + persist ---------------------------------------
  const insights = await validateAndPersist({
    toolCalls,
    trigger,
    positions,
    concentration,
    violations,
    settings,
    priceMap,
    replacementOptions,
    replacementStateByTrim: replacementSearch.stateByTrim,
    citationsResolver: buildResolver(articles.map((a) => a.id)),
    log,
    now,
  });

  return {
    insights,
    concentration,
    violations,
    candidates,
    skipped: false,
    tokens: usage,
    llmCallIds: llmCallId ? [llmCallId] : [],
  };
}

function emptyResult(
  concentration: ConcentrationResult,
  violations: ConcentrationViolation[],
  candidates: Candidate[],
  reason: string,
): SuggestRebalanceResult {
  return {
    insights: [],
    concentration,
    violations,
    candidates,
    skipped: true,
    skipReason: reason,
    tokens: {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      cacheCreationTokens: 0,
    },
    llmCallIds: [],
  };
}

export function selectCapTrimTickers(
  concentration: ConcentrationResult,
  violations: readonly ConcentrationViolation[],
): string[] {
  const selected = new Set<string>();
  for (const violation of violations) {
    if (violation.ticker) {
      selected.add(violation.ticker.toUpperCase());
      continue;
    }
    if (!violation.sector) continue;
    const largest = concentration.positionPcts
      .filter((position) => position.sector === violation.sector)
      .sort((a, b) => b.value - a.value)[0];
    if (largest) selected.add(largest.ticker.toUpperCase());
  }
  return [...selected];
}

async function buildReplacementOptions(input: {
  positions: ReadonlyArray<Position>;
  settings: UserSettings;
  oracle: PriceOracle;
  capTrimTickers: readonly string[];
  concentration: ConcentrationResult;
  violations: readonly ConcentrationViolation[];
  log: RebalanceLogger;
  now: Date;
}): Promise<ReplacementSearchResult> {
  const heldTickers = new Set(input.positions.map((position) => position.ticker.toUpperCase()));
  const byTrim = new Map<string, ReplacementOption>();
  const stateByTrim = new Map<string, ReplacementSearchState>(
    input.capTrimTickers.map((ticker) => [ticker.toUpperCase(), 'source-unavailable']),
  );
  const forbiddenSectors = forbiddenBuySectorsForCapTrims({
    concentration: input.concentration,
    violations: input.violations,
    capTrimTickers: input.capTrimTickers,
  });

  let discoveryFresh = false;
  try {
    const latest = await prisma.discoveryScore.aggregate({ _max: { computedAt: true } });
    discoveryFresh = isDiscoveryReplacementDataFresh(latest._max.computedAt, input.now);
  } catch (error) {
    input.log.warn?.(
      { error: error instanceof Error ? error.message : error },
      '[rebalance/engine] replacement freshness check failed',
    );
  }

  if (discoveryFresh) {
    for (const ticker of input.capTrimTickers) {
      stateByTrim.set(ticker.toUpperCase(), 'none-cleared');
    }
    try {
      const discovery = await scoreRotations({
        settings: input.settings,
        priceOracle: input.oracle,
        eligibleTrimTickers: input.capTrimTickers,
        forbiddenBuySectorsByTrim: Object.fromEntries(
          [...forbiddenSectors].map(([ticker, sectors]) => [ticker, [...sectors]]),
        ),
        maxCandidates: Math.max(5, input.positions.length),
        log: input.log,
      });
      for (const candidate of discovery) {
        if (!candidate.trimAccount || !candidate.buyPlacement) continue;
        if (!candidate.buyPlacement.rankedAccountTypes.includes(candidate.trimAccount.type)) {
          continue;
        }
        byTrim.set(candidate.trimTicker, {
          trimTicker: candidate.trimTicker,
          buyTicker: candidate.buyTicker,
          source: 'discovery',
          reason: candidate.rationale,
          scoreDelta: candidate.scoreDelta,
          goalId: null,
        });
        stateByTrim.set(candidate.trimTicker, 'found');
      }
    } catch (error) {
      for (const ticker of input.capTrimTickers) {
        if (!byTrim.has(ticker.toUpperCase())) {
          stateByTrim.set(ticker.toUpperCase(), 'source-unavailable');
        }
      }
      input.log.warn?.(
        { error: error instanceof Error ? error.message : error },
        '[rebalance/engine] discovery replacement ranking failed',
      );
    }
  } else {
    input.log.warn?.(
      { maxAgeHours: DISCOVERY_REPLACEMENT_MAX_AGE_MS / 3_600_000 },
      '[rebalance/engine] discovery replacement batch is missing or stale',
    );
  }

  const positionIds = input.positions.map((position) => position.id);
  if (positionIds.length === 0) return { options: [...byTrim.values()], stateByTrim };
  let links: GoalPositionWithGoal[];
  try {
    links = await prisma.goalPosition.findMany({
      where: {
        positionId: { in: positionIds },
        goal: { archivedAt: null },
      },
      include: {
        goal: { include: { account: true } },
        position: true,
      },
    });
  } catch (error) {
    input.log.warn?.(
      { error: error instanceof Error ? error.message : error },
      '[rebalance/engine] goal-linked replacement lookup failed',
    );
    return { options: [...byTrim.values()], stateByTrim };
  }
  if (links.length === 0) return { options: [...byTrim.values()], stateByTrim };

  let accountSummaries: Awaited<ReturnType<typeof loadAccountSummaries>>;
  try {
    accountSummaries = await loadAccountSummaries();
  } catch (error) {
    input.log.warn?.(
      { error: error instanceof Error ? error.message : error },
      '[rebalance/engine] goal replacement account lookup failed',
    );
    return { options: [...byTrim.values()], stateByTrim };
  }
  for (const link of links) {
    const trimTicker = link.position.ticker.toUpperCase();
    if (!input.capTrimTickers.includes(trimTicker) && !byTrim.has(trimTicker)) continue;
    const goal: GoalInput = {
      id: link.goal.id,
      name: link.goal.name,
      type: link.goal.type,
      targetAmountCad: Number(link.goal.targetAmountCad),
      targetDate: link.goal.targetDate,
      isWithdrawal: link.goal.isWithdrawal,
      riskOverride: link.goal.riskOverride,
      strategy: link.goal.strategy,
      tradingStyle: link.goal.tradingStyle,
      accountId: link.goal.accountId,
      createdAt: link.goal.createdAt,
    };
    let recs: ReturnType<typeof recommendSecurities>;
    try {
      const discoveryPicks = discoveryFresh
        ? await loadTopDiscoveryPicks({
            limit: 12,
            excludeTickers: [...heldTickers],
            accountType: link.goal.account?.type,
            strategy: link.goal.strategy,
            risk: deriveRiskTolerance(goal),
          })
        : [];
      recs = recommendSecurities(goal, {
        limit: 20,
        goalAccountType: link.goal.account?.type,
        usdSubAccountAvailable: link.goal.account?.currency === 'USD',
        discoveryPicks,
        includeDiscoveryPicks: discoveryFresh,
      });
      if (!byTrim.has(trimTicker)) stateByTrim.set(trimTicker, 'none-cleared');
    } catch (error) {
      input.log.warn?.(
        { trimTicker, goalId: link.goal.id, error: error instanceof Error ? error.message : error },
        '[rebalance/engine] goal replacement ranking failed',
      );
      continue;
    }
    for (const rec of recs) {
      const buyTicker = rec.security.ticker.toUpperCase();
      if (heldTickers.has(buyTicker) || buyTicker === trimTicker) continue;
      const [feasible, buyMeta] = await Promise.all([
        isSameAccountReplacementFeasible({
          trimTicker,
          buyTicker,
          positions: input.positions,
          accountSummaries,
        }),
        prisma.tickerUniverse.findUnique({
          where: { symbol: buyTicker },
          select: { sector: true },
        }),
      ]);
      if (!feasible) continue;
      if (buyMeta?.sector && forbiddenSectors.get(trimTicker)?.has(buyMeta.sector)) continue;
      const [trimBlocked, buyBlocked] = await Promise.all([
        isPassCooldownActive(trimTicker, 'trim'),
        isPassCooldownActive(buyTicker, 'buy'),
      ]);
      if (trimBlocked || buyBlocked) continue;
      byTrim.set(trimTicker, {
        trimTicker,
        buyTicker,
        source: 'goal',
        reason: `${link.goal.name}: ${rec.reason}`,
        scoreDelta: Math.max(0.6, rec.fitScore / 100),
        goalId: link.goal.id,
      });
      stateByTrim.set(trimTicker, 'found');
      break;
    }
  }

  return { options: [...byTrim.values()], stateByTrim };
}

export function isDiscoveryReplacementDataFresh(computedAt: Date | null, now: Date): boolean {
  if (!computedAt) return false;
  const ageMs = now.getTime() - computedAt.getTime();
  return ageMs >= 0 && ageMs <= DISCOVERY_REPLACEMENT_MAX_AGE_MS;
}

function forbiddenBuySectorsForCapTrims(input: {
  concentration: ConcentrationResult;
  violations: readonly ConcentrationViolation[];
  capTrimTickers: readonly string[];
}): Map<string, Set<string>> {
  const capTrims = new Set(input.capTrimTickers.map((ticker) => ticker.toUpperCase()));
  const out = new Map<string, Set<string>>();
  for (const violation of input.violations) {
    if (!violation.sector) continue;
    for (const position of input.concentration.positionPcts) {
      if (position.sector !== violation.sector || !capTrims.has(position.ticker)) continue;
      const sectors = out.get(position.ticker) ?? new Set<string>();
      sectors.add(violation.sector);
      out.set(position.ticker, sectors);
    }
  }
  return out;
}

async function isSameAccountReplacementFeasible(input: {
  trimTicker: string;
  buyTicker: string;
  positions: ReadonlyArray<Position>;
  accountSummaries: Awaited<ReturnType<typeof loadAccountSummaries>>;
}): Promise<boolean> {
  const accountIds = new Set(
    input.positions
      .filter((position) => position.ticker.toUpperCase() === input.trimTicker)
      .map((position) => position.accountId),
  );
  if (accountIds.size !== 1) return false;
  const accountId = [...accountIds][0]!;
  const account = input.accountSummaries.find((summary) => summary.id === accountId);
  if (!account || account.archived) return false;
  const profile = await loadStockProfile(input.buyTicker);
  if (!profile) return false;
  const placement = decidePlacement(profile, input.accountSummaries);
  return placement.rankedAccountTypes.includes(account.type);
}

// ---------------------------------------------------------------------------
// Price collection
// ---------------------------------------------------------------------------

async function fetchPrices(
  oracle: PriceOracle,
  tickers: ReadonlyArray<string>,
  log: RebalanceLogger,
): Promise<Map<string, PriceResult | null>> {
  if (tickers.length === 0) return new Map();
  const results = await oracle.getLatestPrices(tickers);
  const out = new Map<string, PriceResult | null>();
  let resolved = 0;
  for (const t of tickers) {
    const r = results[t.toUpperCase()] ?? null;
    out.set(t.toUpperCase(), r);
    if (r) resolved += 1;
  }
  log.info?.(
    { tickers: tickers.length, resolved, fallback: tickers.length - resolved },
    '[rebalance/engine] price fetch complete',
  );
  return out;
}

function toPriceRecord(priceMap: Map<string, PriceResult | null>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [t, r] of priceMap) {
    if (r) out[t] = r.price;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Article window (per-ticker cap)
// ---------------------------------------------------------------------------

interface ArticleRow {
  id: number;
  publishedAt: Date;
  headline: string;
  body: string | null;
  source: string;
  domain: string | null;
  sourceTier: number;
  tickers: string[];
}

async function fetchArticleWindow(input: {
  tickers: ReadonlyArray<string>;
  windowHours: number;
  maxArticles: number;
  perTickerMax: number;
}): Promise<ArticleRow[]> {
  if (input.tickers.length === 0) return [];
  const since = new Date(Date.now() - input.windowHours * 3600_000);
  // Pull a generous superset then trim per-ticker. The DB does not support
  // per-ticker limits in one query (at least not without window functions),
  // so we take 2× the target and bucket client-side.
  const raw = await prisma.article.findMany({
    where: {
      tickers: { hasSome: [...input.tickers] },
      satireBlocked: false,
      publishedAt: { gte: since },
    },
    orderBy: [{ publishedAt: 'desc' }, { sourceTier: 'asc' }],
    take: input.maxArticles * 2,
  });
  const byTicker = new Map<string, number>();
  const out: ArticleRow[] = [];
  for (const a of raw) {
    // Assign each article to its first relevant ticker for per-ticker counting.
    const firstTicker = a.tickers.find((t) => input.tickers.includes(t)) ?? a.tickers[0];
    if (!firstTicker) continue;
    const count = byTicker.get(firstTicker) ?? 0;
    if (count >= input.perTickerMax) continue;
    byTicker.set(firstTicker, count + 1);
    out.push({
      id: a.id,
      publishedAt: a.publishedAt,
      headline: a.headline,
      body: a.body,
      source: a.source,
      domain: a.domain,
      sourceTier: a.sourceTier,
      tickers: a.tickers,
    });
    if (out.length >= input.maxArticles) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Prompt rendering
// ---------------------------------------------------------------------------

function buildSystemAddendum(settings: UserSettings): string {
  const budget = Number(settings.monthlyBudget);
  return [
    'You are producing rebalance and/or buy suggestions for a retail portfolio.',
    `Caps: single position ≤ ${settings.singlePositionCapPct}%, sector ≤ ${settings.sectorCapPct}%.`,
    `Monthly budget available for fresh buys: $${budget.toFixed(2)} USD (this is the cap per suggestion — multiple buys must sum to ≤ budget).`,
    'Prioritize correcting cap violations. If a preselected replacement is supplied, use emit_rotation_suggestion so the trim names what replaces it. Use a one-sided trim/exit only when the prompt explicitly says no replacement cleared the bar or candidate data is unavailable.',
    'For fresh buys use emit_buy_suggestion — the wrapper validates against caps, budget, and price snapshots.',
    'Strong claims (e.g. full exit, buy >10% of budget) require at least one tier-1 citation or confidence MUST be Low.',
    'If nothing is actionable, emit no tool calls.',
  ].join(' ');
}

interface RenderPromptInput {
  trigger: RebalanceTrigger;
  settings: UserSettings;
  concentration: ConcentrationResult;
  violations: ConcentrationViolation[];
  candidates: Candidate[];
  replacementOptions: ReplacementOption[];
  replacementStateByTrim: ReadonlyMap<string, ReplacementSearchState>;
  priceMap: Map<string, PriceResult | null>;
  articles: ArticleRow[];
  articleWindowHours: number;
}

function renderUserPrompt(input: RenderPromptInput): string {
  const parts: string[] = [];
  parts.push(`# Rebalance run`);
  parts.push(`- Trigger: ${input.trigger}`);
  parts.push(`- Monthly budget: $${Number(input.settings.monthlyBudget).toFixed(2)} USD`);
  parts.push(
    `- Caps: single ≤ ${input.settings.singlePositionCapPct}%, sector ≤ ${input.settings.sectorCapPct}%`,
  );
  parts.push('');

  parts.push('## Portfolio snapshot');
  parts.push(
    `- Total value: $${input.concentration.totalValue.toFixed(2)} USD (C$${input.concentration.totalValueCad.toFixed(2)} CAD)`,
  );
  parts.push(
    `- Prices resolved from market: ${input.concentration.pricesResolved}/${input.concentration.positionPcts.length} (rest use avgCost)`,
  );
  for (const pp of input.concentration.positionPcts) {
    const priceInfo = input.priceMap.get(pp.ticker);
    const priceLabel = priceInfo
      ? `${formatNativeMoney(priceInfo.price, priceInfo.currency)} via ${priceInfo.source}`
      : `${formatNativeMoney(pp.pricePerShare, pp.currency)} (avgCost)`;
    const nativeValueLabel =
      pp.currency === 'CAD' ? ` · ${formatNativeMoney(pp.nativeValue, pp.currency)} native` : '';
    parts.push(
      `- ${pp.ticker}: ${pp.shares.toFixed(2)} sh · ${priceLabel} · $${pp.value.toFixed(2)} USD${nativeValueLabel} (${pp.pct.toFixed(1)}%)${pp.sector ? ` · sector ${pp.sector}` : ''}`,
    );
  }
  if (input.concentration.sectorPcts.length > 0) {
    parts.push('');
    parts.push('### Sector weights');
    for (const sp of input.concentration.sectorPcts) {
      parts.push(`- ${sp.sector}: ${sp.pct.toFixed(1)}% ($${sp.value.toFixed(2)} USD)`);
    }
  }
  parts.push('');

  if (input.violations.length > 0) {
    parts.push('## Cap violations (address these first)');
    for (const v of input.violations) {
      if (v.kind === 'single') {
        parts.push(
          `- SINGLE: ${v.ticker} at ${v.pct.toFixed(1)}% (cap ${v.cap}%) — over by ${v.overBy.toFixed(1)}pt`,
        );
      } else {
        parts.push(
          `- SECTOR: ${v.sector} at ${v.pct.toFixed(1)}% (cap ${v.cap}%) — over by ${v.overBy.toFixed(1)}pt`,
        );
      }
    }
    parts.push('');
  } else {
    parts.push('## Cap violations');
    parts.push('(None.)');
    parts.push('');
  }

  if (input.candidates.length > 0) {
    parts.push('## Candidate tickers');
    parts.push('(Tickers with active PassCooldown for "buy" have already been filtered out.)');
    for (const c of input.candidates) {
      const priceInfo = input.priceMap.get(c.ticker);
      const priceLabel = priceInfo
        ? formatNativeMoney(priceInfo.price, priceInfo.currency)
        : '(no price — compute shares using a reasonable proxy if you must cite)';
      parts.push(
        `- ${c.ticker}: ${c.reason} · mentions=${c.mentions}, events=${c.eventCount}, score=${c.score.toFixed(2)}${c.sector ? `, sector=${c.sector}` : ''} · ${priceLabel}${c.isHeld ? ' · HELD' : ''}${c.isOnWatchlist ? ' · WATCHLIST' : ''}`,
      );
    }
    parts.push('');
  }

  parts.push('## Preselected replacement options');
  if (input.replacementOptions.length === 0) {
    parts.push('(None.)');
  } else {
    parts.push(
      'These are the only approved buy legs for a trim/exit. The wrapper will normalize dollar-neutral shares and re-check exact post-swap caps.',
    );
    for (const option of input.replacementOptions) {
      parts.push(
        `- ${option.trimTicker} -> ${option.buyTicker} · ${option.source}${option.goalId ? ` goal=${option.goalId}` : ''} · delta=${option.scoreDelta.toFixed(2)} · ${option.reason}`,
      );
    }
  }
  const missingReplacements = [...input.replacementStateByTrim].filter(
    ([ticker, state]) =>
      state !== 'found' && !input.replacementOptions.some((option) => option.trimTicker === ticker),
  );
  for (const [ticker, state] of missingReplacements) {
    parts.push(
      state === 'source-unavailable'
        ? `- ${ticker}: candidate data is missing or stale; do not invent a buy leg.`
        : `- ${ticker}: no candidate cleared discovery/goal fit, cooldown, account, and preliminary cap gates.`,
    );
  }
  parts.push('');

  parts.push(renderArticles(input.articles, input.articleWindowHours));

  parts.push('# Instruction');
  parts.push('');
  parts.push(
    'Emit 0-3 tool calls total. Use `emit_rotation_suggestion` whenever a trim/exit ticker has a preselected replacement above. Use `emit_rebalance_suggestion` only for buy-more or when no replacement cleared the bar. Never invent a replacement when candidate data is unavailable. Use `emit_buy_suggestion` for fresh buys within monthly budget. Cite at least one article per call. If the portfolio is clean and no opportunity is compelling, emit no tool calls.',
  );
  return parts.join('\n');
}

function renderArticles(articles: ArticleRow[], windowHours: number): string {
  if (articles.length === 0) {
    return `## Recent news window (last ${windowHours}h)\n\n(No qualifying articles in this window.)\n`;
  }
  const lines: string[] = [];
  lines.push(`## Recent news window (last ${windowHours}h, ${articles.length} articles)`);
  lines.push('');
  lines.push(
    'Cite by `articleId`. Tier 1 = Reuters/Bloomberg/AP/SEC; tier 3 = StockTwits (weak evidence only).',
  );
  lines.push('');
  const bodyLimit = 600;
  for (const a of articles) {
    const body = a.body ? a.body.slice(0, bodyLimit) : '';
    const trunc = a.body && a.body.length > bodyLimit ? ' …[truncated]' : '';
    const tickers = a.tickers.length > 0 ? ` · tickers: ${a.tickers.join(', ')}` : '';
    lines.push(
      `[articleId: ${a.id}] (tier ${a.sourceTier} · ${a.source}${a.domain ? ` · ${a.domain}` : ''}${tickers})`,
    );
    lines.push(`  ${a.publishedAt.toISOString()} — ${a.headline}`);
    if (body) lines.push(`  ${body.replace(/\s+/g, ' ').trim()}${trunc}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Validation + persistence
// ---------------------------------------------------------------------------

interface ValidateInput {
  toolCalls: ReadonlyArray<ParsedToolCall>;
  trigger: RebalanceTrigger;
  positions: ReadonlyArray<Position>;
  concentration: ConcentrationResult;
  violations: ReadonlyArray<ConcentrationViolation>;
  settings: UserSettings;
  priceMap: Map<string, PriceResult | null>;
  replacementOptions: ReadonlyArray<ReplacementOption>;
  replacementStateByTrim: ReadonlyMap<string, ReplacementSearchState>;
  citationsResolver: (articleId: number) => boolean;
  log: RebalanceLogger;
  now: () => Date;
}

async function validateAndPersist(input: ValidateInput): Promise<Insight[]> {
  const {
    toolCalls,
    trigger,
    positions,
    concentration,
    violations,
    settings,
    priceMap,
    replacementOptions,
    replacementStateByTrim,
    citationsResolver,
    log,
    now,
  } = input;

  const triggeredBy = `rebalance:${trigger}`;
  const out: Insight[] = [];

  // Budget tracking for multi-buy aggregate enforcement.
  let remainingBudget = Number(settings.monthlyBudget);
  let running = cloneConcentration(concentration);

  const violationTickers = new Set(
    violations
      .filter((v): v is ConcentrationViolation & { ticker: string } => Boolean(v.ticker))
      .map((v) => v.ticker.toUpperCase()),
  );
  const violationSectors = new Set(
    violations
      .filter((v): v is ConcentrationViolation & { sector: string } => Boolean(v.sector))
      .map((v) => v.sector),
  );
  const replacementByTrim = new Map(
    replacementOptions.map((option) => [option.trimTicker.toUpperCase(), option]),
  );

  // Resolver closes over the prompt's articleId set — citations referencing
  // articles outside the rebalance prompt window get dropped.
  const resolver = async (ids: number[]): Promise<Set<number>> => {
    const resolved = new Set<number>();
    for (const id of ids) if (citationsResolver(id)) resolved.add(id);
    return resolved;
  };

  for (const raw of toolCalls) {
    const { call: stripped, droppedCitations } = await stripUncitedCall(raw, resolver);
    if (droppedCitations.length > 0) {
      log.warn?.(
        {
          kind: raw.kind,
          dropped: droppedCitations.length,
        },
        '[rebalance/engine] hallucinated citations stripped',
      );
    }
    if (!stripped) {
      log.warn?.(
        { kind: raw.kind },
        '[rebalance/engine] all citations hallucinated — dropping tool call',
      );
      continue;
    }

    if (stripped.kind === 'emit_rebalance_suggestion') {
      const ticker = stripped.payload.ticker.toUpperCase();
      const replacement = replacementByTrim.get(ticker) ?? null;
      const replacementConsidered =
        stripped.payload.action === 'trim' ||
        stripped.payload.action === 'exit' ||
        stripped.payload.action === 'rotate';
      let insight: Awaited<ReturnType<typeof handleRebalanceCall>> = null;
      if (replacementConsidered && replacement) {
        insight = await handleRotationCall({
          call: toRotationCall(stripped, replacement),
          positions,
          running,
          violationTickers,
          violationSectors,
          priceMap,
          settings,
          triggeredBy,
          replacement,
          log,
          now,
        });
      }
      if (!insight) {
        insight = await handleRebalanceCall({
          call: toOneSidedRebalanceCall(stripped),
          positions,
          running,
          violationTickers,
          violationSectors,
          priceMap,
          settings,
          triggeredBy,
          replacementConsidered,
          replacementFound: false,
          replacementState:
            replacement !== null
              ? 'none-cleared'
              : (replacementStateByTrim.get(ticker) ?? 'none-cleared'),
          log,
          now,
        });
      }
      if (insight) {
        out.push(insight.insight);
        running = insight.nextConcentration;
      }
    } else if (stripped.kind === 'emit_rotation_suggestion') {
      const trimTicker = stripped.payload.trimTicker.toUpperCase();
      const replacement = replacementByTrim.get(trimTicker) ?? null;
      let insight: Awaited<ReturnType<typeof handleRotationCall>> = replacement
        ? await handleRotationCall({
            call: stripped,
            positions,
            running,
            violationTickers,
            violationSectors,
            priceMap,
            settings,
            triggeredBy,
            replacement,
            log,
            now,
          })
        : null;
      if (!insight) {
        insight = await handleRebalanceCall({
          call: rotationToOneSidedCall(stripped),
          positions,
          running,
          violationTickers,
          violationSectors,
          priceMap,
          settings,
          triggeredBy,
          replacementConsidered: true,
          replacementFound: false,
          replacementState:
            replacement !== null
              ? 'none-cleared'
              : (replacementStateByTrim.get(trimTicker) ?? 'none-cleared'),
          log,
          now,
        });
      }
      if (insight) {
        out.push(insight.insight);
        running = insight.nextConcentration;
      }
    } else if (stripped.kind === 'emit_buy_suggestion') {
      const insight = await handleBuyCall({
        call: stripped,
        running,
        priceMap,
        settings,
        remainingBudget,
        triggeredBy,
        log,
        now,
      });
      if (insight) {
        out.push(insight.insight);
        remainingBudget = insight.nextRemainingBudget;
        running = insight.nextConcentration;
      }
    }
    // Other tool kinds are ignored silently; the model only receives these
    // three schemas.
  }

  return out;
}

// ---- Rebalance (trim/rotate/exit/buy-more) handler ------------------------

interface HandleRebalanceInput {
  call: Extract<ParsedToolCall, { kind: 'emit_rebalance_suggestion' }>;
  positions: ReadonlyArray<Position>;
  running: ConcentrationResult;
  violationTickers: ReadonlySet<string>;
  violationSectors: ReadonlySet<string>;
  priceMap: Map<string, PriceResult | null>;
  settings: UserSettings;
  triggeredBy: string;
  replacementConsidered: boolean;
  replacementFound: boolean;
  replacementState: ReplacementSearchState;
  log: RebalanceLogger;
  now: () => Date;
}

async function handleRebalanceCall(
  input: HandleRebalanceInput,
): Promise<{ insight: Insight; nextConcentration: ConcentrationResult } | null> {
  const {
    call,
    positions,
    running,
    violationTickers,
    priceMap,
    settings,
    triggeredBy,
    replacementConsidered,
    replacementFound,
    replacementState,
    log,
    now,
  } = input;
  const p: RebalanceSuggestionPayload = call.payload;
  const ticker = p.ticker.toUpperCase();

  // Share-count sanity.
  if (!Number.isFinite(p.shares) || p.shares < MIN_FRACTIONAL_SHARES) {
    log.warn?.(
      { ticker, shares: p.shares },
      '[rebalance/engine] share count below fractional minimum — dropping',
    );
    return null;
  }

  // Cooldown check — the action-specific kind maps 1:1 for trim/rotate;
  // buy-more uses 'buy', exit uses 'trim' (there's no 'exit' cooldown kind).
  const actionKind = mapActionKind(p.action);
  const cooldownActive = await isPassCooldownActive(ticker, actionKind);
  if (cooldownActive) {
    log.info?.(
      { ticker, action: p.action },
      '[rebalance/engine] suggestion dropped — active PassCooldown',
    );
    return null;
  }

  // Existing-position check for trim/rotate/exit.
  const heldPosition = positions.find((pos) => pos.ticker.toUpperCase() === ticker);
  if ((p.action === 'trim' || p.action === 'exit' || p.action === 'rotate') && !heldPosition) {
    log.warn?.(
      { ticker, action: p.action },
      '[rebalance/engine] cannot act on unheld position — dropping',
    );
    return null;
  }

  // For action=buy on an EXISTING position we apply the buy-side cap
  // validator; for trim/rotate/exit the whole point is to REDUCE exposure,
  // so we do a lighter sanity: the proposed trim can't be larger than the
  // current share count.
  if (p.action === 'trim' || p.action === 'exit' || p.action === 'rotate') {
    const held = Number(heldPosition!.shares);
    if (p.shares > held + 0.01) {
      log.warn?.(
        { ticker, requested: p.shares, held },
        '[rebalance/engine] trim/exit/rotate larger than held shares — clamping to held',
      );
      // Clamp — we don't drop, because this is common model behavior on
      // the edge and a full exit is the intent either way.
      p.shares = held;
    }
  } else if (p.action === 'buy') {
    // Buy-more on an existing position. Use the same cap validator as buys.
    const priceResult = priceMap.get(ticker);
    const priceUsd = priceResult
      ? nativeAmountToUsd(priceResult.price, priceResult.currency, running.usdCadRate)
      : 0;
    const pp = running.positionPcts.find((x) => x.ticker === ticker);
    const buyCtx: BuySuggestionContext = {
      pricePerShare: priceUsd,
      totalPortfolioValue: running.totalValue,
      sector: pp?.sector ?? null,
      sectorCurrentValue: pp?.sector
        ? (running.sectorPcts.find((s) => s.sector === pp.sector)?.value ?? 0)
        : 0,
      tickerCurrentValue: pp?.value ?? 0,
    };
    const violation = capValidator(
      {
        ticker,
        shares: p.shares,
        reasoning: p.reasoning,
        citations: p.citations,
        confidence: p.confidence,
      },
      settings,
      buyCtx,
      Number(settings.monthlyBudget),
    );
    if (violation) {
      log.warn?.(
        {
          ticker,
          reason: violation.reason,
          detail: violation.detail,
        },
        '[rebalance/engine] rebalance-buy failed cap validation',
      );
      return null;
    }
  }

  // Double-write guard: skip if an Insight with the same action+ticker was
  // written in the last 24h.
  const duplicate = await findRecentDuplicate({
    ticker,
    action: p.action,
    kindLabel: 'rebalance',
    now: now(),
  });
  if (duplicate) {
    log.info?.(
      { ticker, action: p.action, existingId: duplicate.id },
      '[rebalance/engine] duplicate within 24h — skipping',
    );
    return null;
  }

  // Persist.
  const replacementActionState = buildReplacementActionState({
    considered: replacementConsidered,
    found: replacementFound,
    state: replacementState,
  });
  const replacementNote = replacementActionState.replacementNote;
  const body = replacementNote ? `${p.reasoning}\n\n${replacementNote}` : p.reasoning;
  const insight = await prisma.insight.create({
    data: {
      kind: InsightKind.Rebalance,
      title: formatRebalanceTitle(p),
      body,
      reasoning: p.reasoning,
      citations: toJsonCitations(p.citations),
      actionJson: buildRebalanceActionJson(p, {
        source: triggeredBy,
        violatedCap: violationTickers.has(ticker),
        priceSnapshot: priceMap.get(ticker)?.price ?? null,
        priceCurrency: priceMap.get(ticker)?.currency ?? heldPosition?.currency ?? null,
        ...replacementActionState,
      }),
      confidence: resolveConfidence(p.confidence, p.citations),
      status: InsightStatus.New,
      triggeredBy,
    },
  });

  // Update running concentration for downstream budget/sector math.
  const next = applyRebalanceToConcentration(running, p, priceMap);
  return { insight, nextConcentration: next };
}

// ---- Rotation handler ----------------------------------------------------

interface HandleRotationInput {
  call: Extract<ParsedToolCall, { kind: 'emit_rotation_suggestion' }>;
  positions: ReadonlyArray<Position>;
  running: ConcentrationResult;
  violationTickers: ReadonlySet<string>;
  violationSectors: ReadonlySet<string>;
  priceMap: Map<string, PriceResult | null>;
  settings: UserSettings;
  triggeredBy: string;
  replacement: ReplacementOption | null;
  log: RebalanceLogger;
  now: () => Date;
}

async function handleRotationCall(
  input: HandleRotationInput,
): Promise<{ insight: Insight; nextConcentration: ConcentrationResult } | null> {
  const {
    call,
    positions,
    running,
    violationTickers,
    violationSectors,
    priceMap,
    settings,
    triggeredBy,
    replacement,
    log,
    now,
  } = input;
  const p: RotationSuggestionPayload = call.payload;
  const trimTicker = p.trimTicker.toUpperCase();
  const buyTicker = (replacement?.buyTicker ?? p.buyTicker).toUpperCase();
  if (trimTicker === buyTicker) return null;

  const trimLots = positions.filter((position) => position.ticker.toUpperCase() === trimTicker);
  if (trimLots.length === 0) return null;
  if (positions.some((position) => position.ticker.toUpperCase() === buyTicker)) {
    log.warn?.({ trimTicker, buyTicker }, '[rebalance/engine] rotation buy leg is already held');
    return null;
  }

  const accountIds = new Set(trimLots.map((position) => position.accountId));
  if (accountIds.size !== 1) {
    log.warn?.(
      { trimTicker, accounts: [...accountIds] },
      '[rebalance/engine] rotation requires one source account',
    );
    return null;
  }
  const accountId = [...accountIds][0]!;

  const [trimBlocked, buyBlocked, account, profile, accountSummaries, buyMeta] = await Promise.all([
    isPassCooldownActive(trimTicker, 'trim'),
    isPassCooldownActive(buyTicker, 'buy'),
    prisma.account.findUnique({
      where: { id: accountId },
      select: { id: true, type: true, archivedAt: true },
    }),
    loadStockProfile(buyTicker),
    loadAccountSummaries(),
    prisma.tickerUniverse.findUnique({
      where: { symbol: buyTicker },
      select: { sector: true, currency: true },
    }),
  ]);
  if (trimBlocked || buyBlocked) {
    log.info?.(
      { trimTicker, buyTicker, trimBlocked, buyBlocked },
      '[rebalance/engine] rotation blocked by PassCooldown',
    );
    return null;
  }
  if (!account || account.archivedAt || account.type === 'Corporate' || !profile || !buyMeta) {
    log.warn?.(
      { trimTicker, buyTicker, accountId },
      '[rebalance/engine] rotation lacks same-account placement data',
    );
    return null;
  }
  const placement = decidePlacement(profile, accountSummaries);
  if (!placement.rankedAccountTypes.includes(account.type as PlacementAccountType)) {
    log.warn?.(
      { trimTicker, buyTicker, accountType: account.type },
      '[rebalance/engine] buy leg is not feasible in trim account',
    );
    return null;
  }

  const trimPriceResult = priceMap.get(trimTicker);
  const buyPriceResult = priceMap.get(buyTicker);
  if (!trimPriceResult || !buyPriceResult) {
    log.warn?.(
      { trimTicker, buyTicker },
      '[rebalance/engine] rotation missing one or both price snapshots',
    );
    return null;
  }
  const trimPriceUsd = nativeAmountToUsd(
    trimPriceResult.price,
    trimPriceResult.currency,
    running.usdCadRate,
  );
  const buyPriceUsd = nativeAmountToUsd(
    buyPriceResult.price,
    buyPriceResult.currency,
    running.usdCadRate,
  );
  if (trimPriceUsd <= 0 || buyPriceUsd <= 0) return null;

  const heldShares = trimLots.reduce((sum, position) => sum + Number(position.shares), 0);
  const trimPosition = running.positionPcts.find((position) => position.ticker === trimTicker);
  if (!trimPosition || heldShares < MIN_FRACTIONAL_SHARES) return null;
  const buySector = buyMeta.sector ?? null;
  const minimumTrimUsd = requiredTrimValueUsd({
    running,
    trimTicker,
    trimSector: trimPosition.sector,
    buySector,
    violationTickers,
    violationSectors,
    settings,
  });
  let trimShares = Math.max(p.trimShares, minimumTrimUsd / trimPriceUsd);
  trimShares = Math.min(heldShares, trimShares);
  if (!Number.isFinite(trimShares) || trimShares < MIN_FRACTIONAL_SHARES) return null;

  const trimValueUsd = trimShares * trimPriceUsd;
  const buyShares = trimValueUsd / buyPriceUsd;
  if (!Number.isFinite(buyShares) || buyShares < MIN_FRACTIONAL_SHARES) return null;

  const capResult = evaluateRotationCaps({
    concentration: running,
    buyTicker,
    buySector,
    trimSector: trimPosition.sector,
    trimValueUsd,
    singlePositionCapPct: settings.singlePositionCapPct,
    sectorCapPct: settings.sectorCapPct,
  });
  if (!capResult.ok) {
    log.warn?.(
      { trimTicker, buyTicker, reason: capResult.reason },
      '[rebalance/engine] rotation buy leg failed preliminary cap check',
    );
    return null;
  }

  const next = applyRotationToConcentration({
    running,
    trimTicker,
    trimShares,
    trimPrice: trimPriceResult,
    buyTicker,
    buyShares,
    buyPrice: buyPriceResult,
    buySector,
  });
  const postViolations = checkCaps(next, settings).violations;
  const unresolvedTrimViolation = postViolations.some(
    (violation) =>
      (violation.ticker?.toUpperCase() === trimTicker && violationTickers.has(trimTicker)) ||
      (violation.sector === trimPosition.sector &&
        trimPosition.sector !== null &&
        violationSectors.has(trimPosition.sector)),
  );
  const replacementRebreached = postViolations.some(
    (violation) =>
      violation.ticker?.toUpperCase() === buyTicker ||
      (buySector !== null && violation.sector === buySector),
  );
  if (unresolvedTrimViolation || replacementRebreached) {
    log.warn?.(
      { trimTicker, buyTicker, unresolvedTrimViolation, replacementRebreached },
      '[rebalance/engine] exact post-swap cap check failed',
    );
    return null;
  }

  const [trimDuplicate, buyDuplicate] = await Promise.all([
    findRecentDuplicate({
      ticker: trimTicker,
      action: 'rotate',
      kindLabel: 'rebalance',
      now: now(),
    }),
    findRecentDuplicate({ ticker: buyTicker, action: 'buy', kindLabel: 'buy', now: now() }),
  ]);
  if (trimDuplicate || buyDuplicate) return null;

  const scoreDelta = replacement?.scoreDelta ?? p.scoreDelta;
  const insight = await prisma.insight.create({
    data: {
      kind: InsightKind.Rebalance,
      title: `Rotate ${trimShares.toFixed(4)} ${trimTicker} -> ${buyTicker}`,
      body: p.reasoning,
      reasoning: p.reasoning,
      citations: toJsonCitations(p.citations),
      actionJson: {
        type: 'rotation',
        ticker: buyTicker,
        shares: buyShares,
        trimTicker,
        trimShares,
        trimPriceSnapshot: trimPriceResult.price,
        trimPriceCurrency: trimPriceResult.currency,
        buyTicker,
        buyShares,
        priceSnapshot: buyPriceResult.price,
        priceCurrency: buyPriceResult.currency,
        scoreDelta,
        accountId,
        source: replacement?.source ?? triggeredBy,
        goalId: replacement?.goalId ?? null,
        ...buildReplacementActionState({ considered: true, found: true, state: 'found' }),
      } as Prisma.InputJsonValue,
      confidence: resolveConfidence('Medium', p.citations),
      status: InsightStatus.New,
      triggeredBy,
    },
  });
  return { insight, nextConcentration: next };
}

// ---- Buy suggestion handler ----------------------------------------------

interface HandleBuyInput {
  call: Extract<ParsedToolCall, { kind: 'emit_buy_suggestion' }>;
  running: ConcentrationResult;
  priceMap: Map<string, PriceResult | null>;
  settings: UserSettings;
  remainingBudget: number;
  triggeredBy: string;
  log: RebalanceLogger;
  now: () => Date;
}

async function handleBuyCall(input: HandleBuyInput): Promise<{
  insight: Insight;
  nextRemainingBudget: number;
  nextConcentration: ConcentrationResult;
} | null> {
  const { call, running, priceMap, settings, remainingBudget, triggeredBy, log, now } = input;
  const p: BuySuggestionPayload = call.payload;
  const ticker = p.ticker.toUpperCase();

  if (!Number.isFinite(p.shares) || p.shares < MIN_FRACTIONAL_SHARES) {
    log.warn?.(
      { ticker, shares: p.shares },
      '[rebalance/engine] buy share count below fractional minimum — dropping',
    );
    return null;
  }

  const cooldownActive = await isPassCooldownActive(ticker, 'buy');
  if (cooldownActive) {
    log.info?.({ ticker }, '[rebalance/engine] buy dropped — active buy cooldown');
    return null;
  }

  const priceResult = priceMap.get(ticker);
  const nativePrice = priceResult?.price ?? 0;
  const currency = priceResult?.currency ?? 'USD';
  const priceUsd = priceResult ? nativeAmountToUsd(nativePrice, currency, running.usdCadRate) : 0;
  const pp = running.positionPcts.find((x) => x.ticker === ticker);
  const buyCtx: BuySuggestionContext = {
    pricePerShare: priceUsd,
    totalPortfolioValue: running.totalValue,
    sector: pp?.sector ?? null,
    sectorCurrentValue: pp?.sector
      ? (running.sectorPcts.find((s) => s.sector === pp.sector)?.value ?? 0)
      : 0,
    tickerCurrentValue: pp?.value ?? 0,
  };

  const violation = capValidator(p, settings, buyCtx, remainingBudget);
  if (violation) {
    log.warn?.(
      { ticker, reason: violation.reason, detail: violation.detail },
      '[rebalance/engine] buy failed cap validation',
    );
    return null;
  }

  const duplicate = await findRecentDuplicate({
    ticker,
    action: 'buy',
    kindLabel: 'buy',
    now: now(),
  });
  if (duplicate) {
    log.info?.(
      { ticker, existingId: duplicate.id },
      '[rebalance/engine] duplicate buy within 24h — skipping',
    );
    return null;
  }

  const nativeCost = p.shares * nativePrice;
  const dollarCostUsd = p.shares * priceUsd;
  const insight = await prisma.insight.create({
    data: {
      kind: InsightKind.BuySuggestion,
      title: `Buy ${p.shares} ${ticker} (~$${dollarCostUsd.toFixed(2)} USD)`,
      body: p.reasoning,
      reasoning: p.reasoning,
      citations: toJsonCitations(p.citations),
      actionJson: buildBuyActionJson(p, {
        source: triggeredBy,
        priceSnapshot: nativePrice || null,
        priceCurrency: priceResult?.currency ?? null,
        dollarCost: dollarCostUsd,
        dollarCostUsd,
      }),
      confidence: resolveConfidence(p.confidence, p.citations),
      status: InsightStatus.New,
      triggeredBy,
    },
  });

  const nextRemainingBudget = remainingBudget - dollarCostUsd;
  const nextConcentration = applyBuyToConcentration(
    running,
    ticker,
    p.shares,
    nativePrice,
    currency,
    nativeCost,
    dollarCostUsd,
    pp?.sector ?? null,
  );
  return { insight, nextRemainingBudget, nextConcentration };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function replacementNoteForState(state: ReplacementSearchState): string {
  if (state === 'source-unavailable') {
    return 'Replacement data was missing or stale. Refresh Discovery before treating this as a final one-sided decision.';
  }
  return 'No candidate cleared the goal fit, cooldown, same-account, dollar-neutral, and post-swap cap checks.';
}

export function buildReplacementActionState(input: {
  considered: boolean;
  found: boolean;
  state: ReplacementSearchState;
}): {
  replacementConsidered: boolean;
  replacementFound: boolean;
  replacementState: ReplacementSearchState | 'not-considered';
  replacementNote: string | null;
} {
  if (!input.considered) {
    return {
      replacementConsidered: false,
      replacementFound: false,
      replacementState: 'not-considered',
      replacementNote: null,
    };
  }
  if (input.found) {
    return {
      replacementConsidered: true,
      replacementFound: true,
      replacementState: 'found',
      replacementNote: null,
    };
  }
  return {
    replacementConsidered: true,
    replacementFound: false,
    replacementState: input.state,
    replacementNote: replacementNoteForState(input.state),
  };
}

function toRotationCall(
  call: Extract<ParsedToolCall, { kind: 'emit_rebalance_suggestion' }>,
  replacement: ReplacementOption,
): Extract<ParsedToolCall, { kind: 'emit_rotation_suggestion' }> {
  return {
    kind: 'emit_rotation_suggestion',
    id: `${call.id}:rotation`,
    payload: {
      trimTicker: call.payload.ticker.toUpperCase(),
      trimShares: call.payload.shares,
      buyTicker: replacement.buyTicker,
      buyShares: 1,
      scoreDelta: replacement.scoreDelta,
      reasoning: `${call.payload.reasoning} Replacement: ${replacement.reason}`,
      citations: call.payload.citations,
    },
  };
}

function toOneSidedRebalanceCall(
  call: Extract<ParsedToolCall, { kind: 'emit_rebalance_suggestion' }>,
): Extract<ParsedToolCall, { kind: 'emit_rebalance_suggestion' }> {
  if (call.payload.action !== 'rotate') return call;
  return {
    ...call,
    payload: {
      ...call.payload,
      action: 'trim',
      targetTicker: undefined,
    },
  };
}

function rotationToOneSidedCall(
  call: Extract<ParsedToolCall, { kind: 'emit_rotation_suggestion' }>,
): Extract<ParsedToolCall, { kind: 'emit_rebalance_suggestion' }> {
  return {
    kind: 'emit_rebalance_suggestion',
    id: `${call.id}:trim`,
    payload: {
      action: 'trim',
      ticker: call.payload.trimTicker,
      shares: call.payload.trimShares,
      reasoning: call.payload.reasoning,
      citations: call.payload.citations,
      confidence: 'Medium',
    },
  };
}

export function requiredTrimValueUsd(input: {
  running: ConcentrationResult;
  trimTicker: string;
  trimSector: string | null;
  buySector: string | null;
  violationTickers: ReadonlySet<string>;
  violationSectors: ReadonlySet<string>;
  settings: Pick<UserSettings, 'singlePositionCapPct' | 'sectorCapPct'>;
}): number {
  let required = 0;
  const trimPosition = input.running.positionPcts.find(
    (position) => position.ticker === input.trimTicker,
  );
  if (trimPosition && input.violationTickers.has(input.trimTicker)) {
    const capValue = input.running.totalValue * (input.settings.singlePositionCapPct / 100);
    required = Math.max(required, trimPosition.value - capValue);
  }
  if (input.trimSector && input.violationSectors.has(input.trimSector)) {
    if (input.buySector === input.trimSector) return Number.POSITIVE_INFINITY;
    const sector = input.running.sectorPcts.find((item) => item.sector === input.trimSector);
    if (sector) {
      const capValue = input.running.totalValue * (input.settings.sectorCapPct / 100);
      required = Math.max(required, sector.value - capValue);
    }
  }
  return Math.max(0, required);
}

export function applyRotationToConcentration(input: {
  running: ConcentrationResult;
  trimTicker: string;
  trimShares: number;
  trimPrice: PriceResult;
  buyTicker: string;
  buyShares: number;
  buyPrice: PriceResult;
  buySector: string | null;
}): ConcentrationResult {
  const next = cloneConcentration(input.running);
  const trimPosition = next.positionPcts.find((position) => position.ticker === input.trimTicker);
  if (!trimPosition) return next;

  const trimNativeValue = input.trimShares * input.trimPrice.price;
  const trimValueUsd = nativeAmountToUsd(
    trimNativeValue,
    input.trimPrice.currency,
    next.usdCadRate,
  );
  trimPosition.shares = Math.max(0, trimPosition.shares - input.trimShares);
  trimPosition.nativeValue = Math.max(0, trimPosition.nativeValue - trimNativeValue);
  trimPosition.value = Math.max(0, trimPosition.value - trimValueUsd);
  if (trimPosition.sector) {
    const sector = next.sectorPcts.find((item) => item.sector === trimPosition.sector);
    if (sector) sector.value = Math.max(0, sector.value - trimValueUsd);
  }

  const buyNativeValue = input.buyShares * input.buyPrice.price;
  const buyValueUsd = nativeAmountToUsd(buyNativeValue, input.buyPrice.currency, next.usdCadRate);
  const buyPosition = next.positionPcts.find((position) => position.ticker === input.buyTicker);
  if (buyPosition) {
    buyPosition.shares += input.buyShares;
    buyPosition.nativeValue += buyNativeValue;
    buyPosition.value += buyValueUsd;
  } else {
    next.positionPcts.push({
      ticker: input.buyTicker,
      sector: input.buySector,
      shares: input.buyShares,
      pricePerShare: input.buyPrice.price,
      nativeValue: buyNativeValue,
      value: buyValueUsd,
      currency: input.buyPrice.currency,
      pct: 0,
      pricedFromMarket: true,
    });
  }
  if (input.buySector) {
    const sector = next.sectorPcts.find((item) => item.sector === input.buySector);
    if (sector) sector.value += buyValueUsd;
    else next.sectorPcts.push({ sector: input.buySector, value: buyValueUsd, pct: 0 });
  }
  recomputePcts(next);
  return next;
}

function mapActionKind(action: RebalanceSuggestionPayload['action']): 'buy' | 'trim' | 'rotate' {
  if (action === 'buy') return 'buy';
  if (action === 'rotate') return 'rotate';
  // trim + exit share the 'trim' cooldown namespace — there's no separate
  // exit cooldown kind.
  return 'trim';
}

function formatRebalanceTitle(p: RebalanceSuggestionPayload): string {
  const head = `${capitalize(p.action)} ${p.shares} ${p.ticker}`;
  if (p.action === 'rotate' && p.targetTicker) {
    return `${head} → ${p.targetTicker}`;
  }
  return head;
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function toJsonCitations(citations: Citation[]): Prisma.InputJsonValue {
  return citations.map((c) => ({
    articleId: c.articleId,
    quote: c.quote,
  })) as Prisma.InputJsonValue;
}

function buildRebalanceActionJson(
  p: RebalanceSuggestionPayload,
  extras: Record<string, unknown>,
): Prisma.InputJsonValue {
  const base: Record<string, unknown> = {
    type: 'rebalance',
    action: p.action,
    ticker: p.ticker,
    shares: p.shares,
    ...extras,
  };
  if (p.targetTicker) base['targetTicker'] = p.targetTicker;
  return base as Prisma.InputJsonValue;
}

function buildBuyActionJson(
  p: BuySuggestionPayload,
  extras: Record<string, unknown>,
): Prisma.InputJsonValue {
  return {
    type: 'buy',
    ticker: p.ticker,
    shares: p.shares,
    ...extras,
  } as Prisma.InputJsonValue;
}

/**
 * Downgrade confidence to Low when zero citations resolved (shouldn't happen
 * post-stripper, but defence in depth). Otherwise trust the model's declared
 * confidence.
 */
function resolveConfidence(declared: 'Low' | 'Medium' | 'High', citations: Citation[]): Confidence {
  if (citations.length === 0) return Confidence.Low;
  if (declared === 'High') return Confidence.High;
  if (declared === 'Medium') return Confidence.Medium;
  return Confidence.Low;
}

function buildResolver(articleIds: number[]): (id: number) => boolean {
  const set = new Set(articleIds);
  return (id: number): boolean => set.has(id);
}

async function findRecentDuplicate(input: {
  ticker: string;
  action: string;
  kindLabel: 'rebalance' | 'buy';
  now: Date;
}): Promise<{ id: number } | null> {
  const since = new Date(input.now.getTime() - 24 * 3600_000);
  const row = await prisma.insight.findFirst({
    where: {
      createdAt: { gte: since },
      actionJson: {
        path: ['ticker'],
        equals: input.ticker,
      },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, actionJson: true },
  });
  if (!row) return null;
  const action = extractAction(row.actionJson);
  if (!action) return null;
  if (action === input.action) return { id: row.id };
  // Also consider a buy + rebalance-buy collision — both imply adding shares.
  if (
    (input.action === 'buy' && action === 'buy') ||
    (input.kindLabel === 'buy' && action === 'buy')
  ) {
    return { id: row.id };
  }
  return null;
}

function extractAction(actionJson: unknown): string | null {
  if (typeof actionJson !== 'object' || actionJson === null) return null;
  const obj = actionJson as Record<string, unknown>;
  const a = obj['action'];
  if (typeof a === 'string') return a;
  const t = obj['type'];
  if (typeof t === 'string') return t;
  return null;
}

function cloneConcentration(c: ConcentrationResult): ConcentrationResult {
  return {
    totalValue: c.totalValue,
    totalValueCad: c.totalValueCad,
    usdCadRate: c.usdCadRate,
    positionPcts: c.positionPcts.map((pp) => ({ ...pp })),
    sectorPcts: c.sectorPcts.map((sp) => ({ ...sp })),
    topHoldings: c.topHoldings.map((pp) => ({ ...pp })),
    pricesResolved: c.pricesResolved,
  };
}

function applyBuyToConcentration(
  c: ConcentrationResult,
  ticker: string,
  shares: number,
  nativePrice: number,
  currency: PortfolioCurrency,
  nativeCost: number,
  dollarCostUsd: number,
  sector: string | null,
): ConcentrationResult {
  const next = cloneConcentration(c);
  next.totalValue += dollarCostUsd;
  next.totalValueCad += usdAmountToCad(dollarCostUsd, next.usdCadRate);
  const pp = next.positionPcts.find((x) => x.ticker === ticker);
  if (pp) {
    pp.value += dollarCostUsd;
    pp.nativeValue += nativeCost;
    pp.shares += shares;
  } else {
    next.positionPcts.push({
      ticker,
      sector,
      shares,
      pricePerShare: nativePrice,
      nativeValue: nativeCost,
      value: dollarCostUsd,
      currency,
      pct: 0,
      pricedFromMarket: true,
    });
  }
  if (sector) {
    const sp = next.sectorPcts.find((s) => s.sector === sector);
    if (sp) sp.value += dollarCostUsd;
    else next.sectorPcts.push({ sector, value: dollarCostUsd, pct: 0 });
  }
  recomputePcts(next);
  return next;
}

function applyRebalanceToConcentration(
  c: ConcentrationResult,
  p: RebalanceSuggestionPayload,
  priceMap: Map<string, PriceResult | null>,
): ConcentrationResult {
  const next = cloneConcentration(c);
  const ticker = p.ticker.toUpperCase();
  const pp = next.positionPcts.find((x) => x.ticker === ticker);
  if (!pp) return next; // Nothing to adjust for unheld actions beyond 'buy'.
  const priceResult = priceMap.get(ticker);
  const price = priceResult?.price ?? pp.pricePerShare;
  const currency = priceResult?.currency ?? pp.currency;
  const nativeDelta = p.shares * price;
  const deltaUsd = nativeAmountToUsd(nativeDelta, currency, next.usdCadRate);
  const deltaCad = usdAmountToCad(deltaUsd, next.usdCadRate);
  switch (p.action) {
    case 'trim':
    case 'exit':
    case 'rotate': {
      pp.value = Math.max(0, pp.value - deltaUsd);
      pp.nativeValue = Math.max(0, pp.nativeValue - nativeDelta);
      pp.shares = Math.max(0, pp.shares - p.shares);
      next.totalValue = Math.max(0, next.totalValue - deltaUsd);
      next.totalValueCad = Math.max(0, next.totalValueCad - deltaCad);
      if (pp.sector) {
        const sp = next.sectorPcts.find((s) => s.sector === pp.sector);
        if (sp) sp.value = Math.max(0, sp.value - deltaUsd);
      }
      break;
    }
    case 'buy': {
      pp.value += deltaUsd;
      pp.nativeValue += nativeDelta;
      pp.shares += p.shares;
      next.totalValue += deltaUsd;
      next.totalValueCad += deltaCad;
      if (pp.sector) {
        const sp = next.sectorPcts.find((s) => s.sector === pp.sector);
        if (sp) sp.value += deltaUsd;
      }
      break;
    }
  }
  recomputePcts(next);
  return next;
}

function recomputePcts(c: ConcentrationResult): void {
  if (c.totalValue <= 0) {
    for (const pp of c.positionPcts) pp.pct = 0;
    for (const sp of c.sectorPcts) sp.pct = 0;
    return;
  }
  for (const pp of c.positionPcts) pp.pct = (pp.value / c.totalValue) * 100;
  for (const sp of c.sectorPcts) sp.pct = (sp.value / c.totalValue) * 100;
  c.topHoldings = [...c.positionPcts]
    .sort((a, b) => b.value - a.value)
    .slice(0, c.topHoldings.length || 5)
    .map((position) => ({ ...position }));
}

function formatNativeMoney(amount: number, currency: PortfolioCurrency): string {
  return `${currency === 'CAD' ? 'C$' : '$'}${amount.toFixed(2)} ${currency}`;
}

// ---------------------------------------------------------------------------
// Default logger
// ---------------------------------------------------------------------------

const defaultLog: RebalanceLogger = {
  info: (obj, msg) => console.info(msg ?? '', obj),
  warn: (obj, msg) => console.warn(msg ?? '', obj),
  error: (obj, msg) => console.error(msg ?? '', obj),
  debug: (obj, msg) => console.debug(msg ?? '', obj),
};
