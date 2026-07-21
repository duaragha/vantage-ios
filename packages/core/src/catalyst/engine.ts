/**
 * Catalyst-driven buy engine — Phase 17.5.
 *
 * Reads unprocessed catalyst MarketEvents from the last `sinceHours` window,
 * groups them by ticker, computes a conjunction level (single signal vs
 * multi-signal vs full triplet), runs each surviving candidate through the
 * shared quality gates + caps + cooldown rules, and asks Sonnet — via the
 * extended `emit_buy_suggestion` tool — for a final size + reasoning. Each
 * approved suggestion lands as an Insight (kind=BuySuggestion) tagged with
 * `triggeredBy: 'catalyst:<EventKind>'` and an `actionJson` payload that
 * carries the catalyst metadata for the dashboard badges + filter chip.
 *
 * Steps (matching spec 17.5):
 *   1. Pull MarketEvents of kinds InsiderCluster | EarningsBeat | Material8K
 *      | AnalystUpgrade with `processedAt = null` and `occurredAt >= since`.
 *   2. Group by ticker. For each ticker:
 *        - count distinct event kinds in the window
 *        - count tier-1 articles in the same window
 *        - look up DiscoveryScore (latest) > 0
 *        - compute conjunctionLevel: 1 = single, 2 = ≥2 kinds OR single +
 *          tier-1 corroboration, 3 = full triplet across insider/earnings/8K
 *   3. Apply qualityFilter — drop with reason logged.
 *   4. Apply PassCooldown (kind='buy') — UNLESS conjunctionLevel === 3 (rare
 *      enough to override; spec ### Phase 17 edge cases).
 *   5. Enforce per-day cap (UserSettings.catalystMaxPerDay) by counting
 *      Insights triggeredBy 'catalyst:%' created today.
 *   6. Enforce daily Sonnet spend cap (UserSettings.catalystDailySpendCapUsd).
 *   7. Honour `catalystRequireConjunction`: drop level-1 candidates when ON.
 *   8. For each surviving candidate, build a Sonnet prompt + call Claude with
 *      the extended emit_buy_suggestion tool.
 *   9. Citation stripper validates the response.
 *  10. capValidator rejects suggestions that violate single-position or sector
 *      caps post-purchase.
 *  11. Persist Insight + actionJson with catalystKind, conjunctionLevel,
 *      urgencyHours=48 + urgencyExpiresAt.
 *  12. Mark consumed MarketEvents as processed.
 *
 * Telegram dispatch is fired from the worker job wrapper, not here — keeping
 * this module pure-ish so smoke tests can run without network deps.
 */

import {
  prisma,
  EventKind,
  InsightKind,
  InsightStatus,
  Confidence,
  isPassCooldownActive,
  type Insight,
  type MarketEvent,
  type Prisma,
  type UserSettings,
  startOfZonedDay,
} from '@vantage/db';
import {
  callClaude,
  SONNET_MODEL,
  buildSystemPrompt,
  buildPortfolioContext,
  stripUncitedCall,
  EMIT_BUY_SUGGESTION_TOOL,
  type BuySuggestionPayload,
  type ParsedToolCall,
  type Citation,
  type CatalystKind,
  type ConjunctionLevel,
} from '@vantage/llm';

import { qualityFilter, type QualityFilterResult } from '../qualityGates.js';
import { capValidator, type BuySuggestionContext } from '../digest.js';
import { decidePlacement } from '../accounts/placement.js';
import { loadAccountSummaries, loadStockProfile } from '../accounts/loaders.js';
import type { AccountType, PlacementDecision } from '../accounts/placement.js';
import { findFittingGoals, type GoalMatch } from '../goals/loaders.js';
import { getUsdCadRate } from '../fx.js';
import {
  auditPortfolio,
  nativeAmountToUsd,
  portfolioCurrency,
  usdAmountToCad,
  type PortfolioAudit,
  type PortfolioCurrency,
} from '../portfolio/valuation.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CatalystLogger {
  info?: (obj: unknown, msg?: string) => void;
  warn?: (obj: unknown, msg?: string) => void;
  error?: (obj: unknown, msg?: string) => void;
  debug?: (obj: unknown, msg?: string) => void;
}

export interface EvaluateCatalystsOptions {
  /** Window length in hours. Default 24h. */
  sinceHours?: number;
  log?: CatalystLogger;
}

export interface CatalystResult {
  /** Number of BuySuggestion Insights persisted. */
  suggestions: number;
  suggestionIds: number[];
  /**
   * Short tags describing why a candidate was skipped. Includes both
   * pre-LLM (`quality:low-mcap`) and post-LLM (`cap:single-position-cap`)
   * reasons so /ops can audit the funnel.
   */
  skippedReason: string[];
  llmCalls: number;
  tokensUsed: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    cacheCreationTokens: number;
  };
  runtimeMs: number;
}

export const CATALYST_KINDS: ReadonlyArray<EventKind> = [
  EventKind.InsiderCluster,
  EventKind.EarningsBeat,
  EventKind.Material8K,
  EventKind.AnalystUpgrade,
];
const CATALYST_PURPOSES = ['catalyst-eval', '8k-classify', 'earnings-guidance'] as const;

const URGENCY_HOURS = 48;

const defaultLog: CatalystLogger = {
  info: (obj, msg) => console.info(msg ?? '', obj),
  warn: (obj, msg) => console.warn(msg ?? '', obj),
  error: (obj, msg) => console.error(msg ?? '', obj),
  debug: (obj, msg) => console.debug(msg ?? '', obj),
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run the catalyst engine for one window. The default cron lives in
 * apps/worker/src/cron.ts — direct callers (smoke tests, manual /jobs trigger)
 * pass `sinceHours` to widen the window.
 */
export async function evaluateCatalysts(
  opts: EvaluateCatalystsOptions = {},
): Promise<CatalystResult> {
  const log = opts.log ?? defaultLog;
  const sinceHours = opts.sinceHours ?? 24;
  const startedAt = Date.now();
  const since = new Date(Date.now() - sinceHours * 3600_000);

  const result: CatalystResult = {
    suggestions: 0,
    suggestionIds: [],
    skippedReason: [],
    llmCalls: 0,
    tokensUsed: {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      cacheCreationTokens: 0,
    },
    runtimeMs: 0,
  };

  // ---- Settings + master enable -----------------------------------------
  const settings = await prisma.userSettings.findUnique({ where: { id: 1 } });
  if (!settings) {
    log.error?.({}, '[catalyst] UserSettings (id=1) missing — cannot run');
    result.runtimeMs = Date.now() - startedAt;
    return result;
  }
  if (!settings.catalystEnabled) {
    log.info?.({}, '[catalyst] disabled via UserSettings.catalystEnabled');
    result.skippedReason.push('disabled');
    result.runtimeMs = Date.now() - startedAt;
    return result;
  }

  // ---- Per-day cap pre-check -------------------------------------------
  const todayStart = startOfZonedDay(new Date(), settings.timezone);
  const todayCount = await prisma.insight.count({
    where: {
      kind: InsightKind.BuySuggestion,
      createdAt: { gte: todayStart },
      triggeredBy: { startsWith: 'catalyst:' },
    },
  });
  if (todayCount >= settings.catalystMaxPerDay) {
    log.info?.(
      { todayCount, cap: settings.catalystMaxPerDay },
      '[catalyst] per-day cap already reached — skipping run',
    );
    result.skippedReason.push('per-day-cap');
    result.runtimeMs = Date.now() - startedAt;
    return result;
  }

  // ---- Spend cap pre-check ---------------------------------------------
  const spendCap = Number(settings.catalystDailySpendCapUsd);
  const todaySpend = await sumCatalystSpendSince(todayStart);
  if (Number.isFinite(spendCap) && spendCap > 0 && todaySpend >= spendCap) {
    log.warn?.(
      { todaySpend, spendCap },
      '[catalyst] daily catalyst spend cap reached — skipping run',
    );
    result.skippedReason.push('spend-cap');
    result.runtimeMs = Date.now() - startedAt;
    return result;
  }

  // ---- Pull unprocessed catalyst MarketEvents --------------------------
  const events = await prisma.marketEvent.findMany({
    where: {
      kind: { in: [...CATALYST_KINDS] },
      processedAt: null,
      occurredAt: { gte: since },
    },
    orderBy: { occurredAt: 'desc' },
  });
  if (events.length === 0) {
    log.info?.({}, '[catalyst] no unprocessed catalyst events in window');
    result.runtimeMs = Date.now() - startedAt;
    return result;
  }

  // ---- Group by ticker --------------------------------------------------
  const byTicker = groupEventsByTicker(events);
  if (byTicker.size === 0) {
    log.info?.(
      { events: events.length },
      '[catalyst] every event missing ticker — nothing to evaluate',
    );
    result.runtimeMs = Date.now() - startedAt;
    return result;
  }

  // ---- Loop tickers -----------------------------------------------------
  let remainingDailyBuys = settings.catalystMaxPerDay - todayCount;
  let runningSpend = todaySpend;

  // Sort tickers by descending conjunction-strength so a tight per-day cap
  // surfaces the strongest signal first. The conjunction level may upgrade
  // from 1 → 2 once we've checked for tier-1 corroboration (next loop), so
  // we precompute base levels here and re-sort after the upgrade pass.
  const baseRanked = await Promise.all(
    [...byTicker.entries()].map(async ([ticker, evs]) => {
      const conj = computeConjunction(evs);
      // Tier-1 corroboration check: any tier-1 article on this ticker in
      // the lookback window upgrades a level-1 candidate to level-2.
      if (conj.level === 1) {
        const since = new Date(Date.now() - sinceHours * 3600_000);
        const tier1 = await prisma.article.findFirst({
          where: {
            tickers: { has: ticker },
            sourceTier: 1,
            satireBlocked: false,
            publishedAt: { gte: since },
          },
          select: { id: true },
        });
        if (tier1) {
          conj.hasTier1Corroboration = true;
          conj.level = 2;
        }
      }
      return { ticker, evs, conj };
    }),
  );
  const ranked = baseRanked.sort((a, b) => b.conj.level - a.conj.level);

  // Snapshot held positions ONCE so cap math is consistent across the run.
  const [heldPositions, usdCadRate] = await Promise.all([
    prisma.position.findMany({ where: { closedAt: null } }),
    getUsdCadRate(),
  ]);
  const portfolioAudit = auditPortfolio({
    positions: heldPositions,
    usdCadRate,
  });

  for (const entry of ranked) {
    if (remainingDailyBuys <= 0) {
      log.info?.(
        { remaining: 0 },
        '[catalyst] per-day cap exhausted mid-run — stopping further candidates',
      );
      result.skippedReason.push('per-day-cap-mid-run');
      break;
    }
    if (Number.isFinite(spendCap) && spendCap > 0 && runningSpend >= spendCap) {
      log.warn?.({ runningSpend, spendCap }, '[catalyst] spend cap exhausted mid-run');
      result.skippedReason.push('spend-cap-mid-run');
      break;
    }

    const { ticker, evs, conj } = entry;
    log.debug?.(
      {
        ticker,
        events: evs.length,
        kinds: [...conj.distinctKinds],
        conjunctionLevel: conj.level,
      },
      '[catalyst] evaluating ticker',
    );

    // Conjunction gate (UserSettings.catalystRequireConjunction).
    if (settings.catalystRequireConjunction && conj.level < 2) {
      log.info?.(
        { ticker, conjunctionLevel: conj.level },
        '[catalyst] skip — single-signal candidate with conjunction required',
      );
      result.skippedReason.push(`${ticker}:single-signal`);
      continue;
    }

    // Quality gate (skip the expensive Sonnet call when fundamentals reject).
    let quality: QualityFilterResult;
    try {
      quality = await qualityFilter(ticker);
    } catch (err) {
      log.error?.(
        { ticker, err: err instanceof Error ? err.message : err },
        '[catalyst] qualityFilter threw — skipping ticker',
      );
      result.skippedReason.push(`${ticker}:quality-error`);
      continue;
    }
    if (!quality.passes) {
      log.info?.(
        { ticker, reason: quality.reason, detail: quality.detail },
        '[catalyst] quality gate rejected ticker',
      );
      result.skippedReason.push(`${ticker}:quality:${quality.reason}`);
      continue;
    }

    // PassCooldown — full triplet (level 3) overrides per spec edge case.
    if (conj.level < 3) {
      const cooled = await isPassCooldownActive(ticker, 'buy');
      if (cooled) {
        log.info?.({ ticker }, '[catalyst] skip — PassCooldown active and conjunction level < 3');
        result.skippedReason.push(`${ticker}:cooldown`);
        continue;
      }
    } else {
      const cooled = await isPassCooldownActive(ticker, 'buy');
      if (cooled) {
        log.info?.(
          { ticker, conjunctionLevel: conj.level },
          '[catalyst] PassCooldown overridden — full triplet',
        );
      }
    }

    // Pull recent articles for prompt context. tier-1/2 only — tier-3 noise
    // is what the conjunction rule is supposed to filter against. Use the
    // engine's full lookback window so the catalyst's accompanying news
    // shows up even when the event landed near the start of the window.
    const articles = await fetchTier1And2Articles(ticker, Math.max(24, sinceHours));
    if (articles.length === 0) {
      log.warn?.(
        { ticker },
        '[catalyst] no tier-1/2 articles in 24h window — skipping (citations would be impossible)',
      );
      result.skippedReason.push(`${ticker}:no-articles`);
      continue;
    }

    // Build prompt + call Sonnet.
    const dominantKind = pickDominantKind(conj.kindEvents, conj.level);
    const userText = renderCatalystUser({
      ticker,
      events: evs,
      conjunction: conj,
      articles,
      audit: portfolioAudit,
      settings,
    });

    let tool: ParsedToolCall | null = null;
    let llmCallId = 0;
    let usage = {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      cacheCreationTokens: 0,
    };
    try {
      const portfolioBlock = await buildPortfolioContext();
      const res = await callClaude({
        model: SONNET_MODEL,
        system: `${buildSystemPrompt()}\n\n${buildCatalystSystem(settings, dominantKind, conj.level)}`,
        portfolio: portfolioBlock,
        cacheSystem: true,
        cachePortfolio: true,
        messages: [{ role: 'user', content: userText }],
        tools: [EMIT_BUY_SUGGESTION_TOOL],
        purpose: 'catalyst-eval',
        maxTokens: 2048,
      });
      result.llmCalls += 1;
      llmCallId = res.llmCallId;
      usage = res.usage;
      result.tokensUsed.inputTokens += usage.inputTokens;
      result.tokensUsed.outputTokens += usage.outputTokens;
      result.tokensUsed.cachedTokens += usage.cachedTokens;
      result.tokensUsed.cacheCreationTokens += usage.cacheCreationTokens;
      runningSpend += Number(res.costUsd ?? 0);
      tool = res.toolCalls.find((c) => c.kind === 'emit_buy_suggestion') ?? null;
    } catch (err) {
      log.error?.(
        { ticker, err: err instanceof Error ? err.message : err },
        '[catalyst] Sonnet call failed — skipping ticker',
      );
      result.skippedReason.push(`${ticker}:llm-error`);
      continue;
    }

    if (!tool || tool.kind !== 'emit_buy_suggestion') {
      log.info?.(
        { ticker, llmCallId },
        '[catalyst] Sonnet emitted no buy suggestion — likely declined',
      );
      result.skippedReason.push(`${ticker}:declined`);
      // Still mark events processed so we don't re-evaluate the same set
      // every hour. The catalyst already informed Sonnet's "no thanks";
      // wait for fresh ones.
      await markEventsProcessed(evs);
      continue;
    }

    // Citation stripper.
    const stripped = await stripUncitedCall(tool);
    if (!stripped.call) {
      log.warn?.(
        { ticker, llmCallId, droppedCount: stripped.droppedCitations.length },
        '[catalyst] all citations hallucinated — dropping suggestion',
      );
      result.skippedReason.push(`${ticker}:no-citations`);
      await markEventsProcessed(evs);
      continue;
    }
    const buyCall = stripped.call as Extract<ParsedToolCall, { kind: 'emit_buy_suggestion' }>;
    const payload: BuySuggestionPayload = buyCall.payload;
    // Force the canonical ticker rather than trusting the model's casing.
    payload.ticker = ticker.toUpperCase();
    // If model omitted catalyst metadata, fall back to our computed values.
    if (!payload.catalystKind) {
      payload.catalystKind = dominantKind;
    }
    if (!payload.conjunctionLevel) {
      payload.conjunctionLevel = conj.level;
    }

    // Cap-aware rejection. Use the latest known close price; fall back to
    // the most recent DailyBar if the held-prices map doesn't carry the
    // ticker. We don't go through the live oracle here because catalyst
    // candidates are by definition unheld — pulling fresh quotes per ticker
    // would burn rate budget for marginal gain.
    const priceSnapshot = await fetchLatestPrice(ticker);
    if (!priceSnapshot) {
      log.warn?.({ ticker }, '[catalyst] no price snapshot — cannot validate caps; dropping');
      result.skippedReason.push(`${ticker}:no-price`);
      continue;
    }
    const priceUsd = nativeAmountToUsd(
      priceSnapshot.price,
      priceSnapshot.currency,
      portfolioAudit.usdCadRate,
    );
    const sector = await fetchSector(ticker);
    const buyCtx: BuySuggestionContext = {
      pricePerShare: priceUsd,
      totalPortfolioValue: portfolioAudit.totalValueUsd,
      sector,
      sectorCurrentValue: sector ? (portfolioAudit.bySector.get(sector)?.valueUsd ?? 0) : 0,
      tickerCurrentValue: portfolioAudit.byTicker.get(ticker.toUpperCase())?.valueUsd ?? 0,
    };
    const violation = capValidator(payload, settings, buyCtx, Number(settings.monthlyBudget));
    if (violation) {
      log.warn?.(
        {
          ticker,
          shares: payload.shares,
          reason: violation.reason,
          detail: violation.detail,
        },
        '[catalyst] capValidator rejected suggestion',
      );
      result.skippedReason.push(`${ticker}:cap:${violation.reason}`);
      continue;
    }

    // Tax-aware account placement — looked up only after capValidator
    // approves the trade so we don't waste DB on declined candidates.
    const placement = await computePlacement(ticker, log);

    // Persist Insight.
    const dollarCost = payload.shares * priceUsd;
    const now = new Date();
    const urgencyExpiresAt = new Date(now.getTime() + URGENCY_HOURS * 3600_000);
    const triggeredKind = payload.catalystKind ?? dominantKind;
    const triggeredBy = `catalyst:${triggeredKind}`;
    const actionJson: Prisma.InputJsonValue = {
      type: 'buy',
      ticker: payload.ticker,
      shares: payload.shares,
      priceSnapshot: priceSnapshot.price,
      priceCurrency: priceSnapshot.currency,
      dollarCost: Number(dollarCost.toFixed(2)),
      dollarCostUsd: Number(dollarCost.toFixed(2)),
      catalystKind: triggeredKind,
      conjunctionLevel: payload.conjunctionLevel ?? conj.level,
      urgencyHours: URGENCY_HOURS,
      urgencyExpiresAt: urgencyExpiresAt.toISOString(),
      sourceEventIds: evs.map((e) => e.id),
      source: 'catalyst-engine',
      accountPlacement: placement
        ? {
            accountType: placement.decision.rankedAccountTypes[0] ?? null,
            accountId: placement.decision.bestAccountId,
            accountName: placement.accountName,
            rationale: placement.decision.rationale,
          }
        : null,
    } as Prisma.InputJsonValue;
    // Append placement footer to the body so it lands in both the dashboard
    // detail and the Telegram message that mirrors `body`.
    const bodyWithPlacement = appendPlacementFooter(payload.reasoning, placement);

    // Goal-fit footer — append after placement so the user sees the goal
    // connection alongside the account guidance. We cap at the top 2 matches
    // (fitScore >= 60) to keep the alert tidy; if more goals fit, the user
    // can still see the full list on the /goals page.
    const goalMatches = await collectGoalMatches(payload.ticker, log);
    const bodyWithGoals = appendGoalFooter(bodyWithPlacement, goalMatches);
    const confidence = inferCatalystConfidence(
      payload.citations,
      articles.map((a) => ({ id: a.id, sourceTier: a.sourceTier })),
      payload.confidence,
    );
    // Stamp matching goals onto the actionJson so the dashboard can render a
    // 🎯 badge or filter chip without re-running the matcher.
    if (goalMatches.length > 0) {
      (actionJson as Record<string, unknown>)['goalMatches'] = goalMatches.map((g) => ({
        goalId: g.goalId,
        goalName: g.goalName,
        goalType: g.goalType,
        fitScore: g.fitScore,
      }));
    }
    const insight = await prisma.insight.create({
      data: {
        kind: InsightKind.BuySuggestion,
        title: `Buy ${payload.shares} ${payload.ticker} (~$${dollarCost.toFixed(2)} USD) · ${triggeredKind}`,
        body: bodyWithGoals,
        reasoning: payload.reasoning,
        citations: payload.citations.map((c) => ({
          articleId: c.articleId,
          quote: c.quote,
        })) as unknown as Prisma.InputJsonValue,
        actionJson,
        confidence,
        status: InsightStatus.New,
        triggeredBy,
      },
    });

    result.suggestions += 1;
    result.suggestionIds.push(insight.id);
    remainingDailyBuys -= 1;

    log.info?.(
      {
        ticker,
        insightId: insight.id,
        catalystKind: triggeredKind,
        conjunctionLevel: payload.conjunctionLevel ?? conj.level,
        confidence,
        dollarCost: dollarCost.toFixed(2),
      },
      '[catalyst] suggestion persisted',
    );

    await markEventsProcessed(evs);

    // Update running portfolio audit so subsequent buys this run respect
    // post-purchase concentration too.
    applyBuyToAudit(portfolioAudit, payload.ticker, dollarCost, sector, priceSnapshot.currency);
  }

  result.runtimeMs = Date.now() - startedAt;
  return result;
}

// ---------------------------------------------------------------------------
// Conjunction logic
// ---------------------------------------------------------------------------

interface ConjunctionInfo {
  level: ConjunctionLevel;
  distinctKinds: Set<EventKind>;
  /** Per-kind list of contributing events (most recent first). */
  kindEvents: Map<EventKind, MarketEvent[]>;
  hasTier1Corroboration: boolean;
  /** DiscoveryScore.score > 0 within last 30d, when present. */
  discoveryPositive: boolean;
}

function groupEventsByTicker(events: MarketEvent[]): Map<string, MarketEvent[]> {
  const out = new Map<string, MarketEvent[]>();
  for (const e of events) {
    if (!e.ticker) continue;
    const k = e.ticker.toUpperCase();
    const arr = out.get(k);
    if (arr) arr.push(e);
    else out.set(k, [e]);
  }
  return out;
}

function computeConjunction(events: MarketEvent[]): ConjunctionInfo {
  const distinctKinds = new Set<EventKind>();
  const kindEvents = new Map<EventKind, MarketEvent[]>();
  for (const e of events) {
    distinctKinds.add(e.kind);
    const arr = kindEvents.get(e.kind);
    if (arr) arr.push(e);
    else kindEvents.set(e.kind, [e]);
  }

  // Triplet test: at least one of {InsiderCluster, EarningsBeat, Material8K}
  // each. Per spec 17.5, the AnalystUpgrade kind is treated as auxiliary —
  // analyst shifts are correlated with the other three but don't unlock the
  // override-cooldown power on their own.
  const triplet =
    distinctKinds.has(EventKind.InsiderCluster) &&
    distinctKinds.has(EventKind.EarningsBeat) &&
    distinctKinds.has(EventKind.Material8K);

  // Conjunction-2: 2+ event kinds OR single + tier-1 corroboration. The
  // tier-1 check is later — at this point we set `level = 2` purely on
  // event-kind diversity and let the caller upgrade if a tier-1 article
  // shows up.
  let level: ConjunctionLevel;
  if (triplet) level = 3;
  else if (distinctKinds.size >= 2) level = 2;
  else level = 1;

  return {
    level,
    distinctKinds,
    kindEvents,
    hasTier1Corroboration: false,
    discoveryPositive: false,
  };
}

function pickDominantKind(
  kindEvents: Map<EventKind, MarketEvent[]>,
  conjunctionLevel: ConjunctionLevel,
): CatalystKind {
  if (conjunctionLevel === 3) return 'mixed';
  if (kindEvents.size > 1) return 'mixed';
  // Single-kind: pick whichever is present.
  if (kindEvents.has(EventKind.InsiderCluster)) return 'InsiderCluster';
  if (kindEvents.has(EventKind.EarningsBeat)) return 'EarningsBeat';
  if (kindEvents.has(EventKind.Material8K)) return 'Material8K';
  if (kindEvents.has(EventKind.AnalystUpgrade)) return 'AnalystUpgrade';
  return 'mixed';
}

// ---------------------------------------------------------------------------
// Article + price + sector helpers
// ---------------------------------------------------------------------------

interface CatalystArticle {
  id: number;
  sourceTier: number;
  source: string;
  domain: string | null;
  publishedAt: Date;
  headline: string;
  body: string | null;
  tickers: string[];
}

async function fetchTier1And2Articles(
  ticker: string,
  windowHours: number,
): Promise<CatalystArticle[]> {
  const since = new Date(Date.now() - windowHours * 3600_000);
  const rows = await prisma.article.findMany({
    where: {
      tickers: { has: ticker.toUpperCase() },
      satireBlocked: false,
      sourceTier: { lte: 2 },
      publishedAt: { gte: since },
    },
    orderBy: [{ publishedAt: 'desc' }, { sourceTier: 'asc' }],
    take: 16,
  });
  return rows.map((a) => ({
    id: a.id,
    sourceTier: a.sourceTier,
    source: a.source,
    domain: a.domain,
    publishedAt: a.publishedAt,
    headline: a.headline,
    body: a.body,
    tickers: a.tickers,
  }));
}

interface CatalystPriceSnapshot {
  price: number;
  currency: PortfolioCurrency;
}

async function fetchLatestPrice(ticker: string): Promise<CatalystPriceSnapshot | null> {
  // Reuse the poller's stored quote before falling back to a daily close. This
  // avoids a provider round trip while keeping intraday cap math current.
  const upperTicker = ticker.toUpperCase();
  const [live, bar, event, universe] = await Promise.all([
    prisma.livePrice.findUnique({ where: { ticker: upperTicker } }),
    prisma.dailyBar.findFirst({
      where: { ticker: upperTicker },
      orderBy: { date: 'desc' },
    }),
    prisma.marketEvent.findFirst({
      where: { ticker: upperTicker, kind: 'IntradayMove' },
      orderBy: { occurredAt: 'desc' },
    }),
    prisma.tickerUniverse.findUnique({
      where: { symbol: upperTicker },
      select: { currency: true },
    }),
  ]);
  const currency = portfolioCurrency(universe?.currency, upperTicker);
  if (live && Date.now() - live.fetchedAt.getTime() <= 10 * 60 * 1000) {
    const price = Number(live.price);
    if (Number.isFinite(price) && price > 0) return { price, currency };
  }
  if (event && Date.now() - event.occurredAt.getTime() <= 24 * 60 * 60 * 1000) {
    const payload = event.payload as Record<string, unknown> | null;
    const candidate = payload?.['price'] ?? payload?.['last'];
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
      return { price: candidate, currency };
    }
  }
  if (bar) {
    const close = Number(bar.close.toString());
    if (Number.isFinite(close) && close > 0) return { price: close, currency };
  }
  return null;
}

async function fetchSector(ticker: string): Promise<string | null> {
  const row = await prisma.tickerUniverse.findUnique({
    where: { symbol: ticker.toUpperCase() },
    select: { sector: true },
  });
  return row?.sector ?? null;
}

function applyBuyToAudit(
  audit: PortfolioAudit,
  ticker: string,
  dollarCostUsd: number,
  sector: string | null,
  currency: PortfolioCurrency,
): void {
  const dollarCostCad = usdAmountToCad(dollarCostUsd, audit.usdCadRate);
  audit.totalValueUsd += dollarCostUsd;
  audit.totalValueCad += dollarCostCad;
  const existing = audit.byTicker.get(ticker.toUpperCase()) ?? {
    valueUsd: 0,
    valueCad: 0,
    pct: 0,
    sector,
    currency,
  };
  existing.valueUsd += dollarCostUsd;
  existing.valueCad += dollarCostCad;
  audit.byTicker.set(ticker.toUpperCase(), existing);
  if (sector) {
    const existingSector = audit.bySector.get(sector) ?? {
      valueUsd: 0,
      valueCad: 0,
      pct: 0,
    };
    existingSector.valueUsd += dollarCostUsd;
    existingSector.valueCad += dollarCostCad;
    audit.bySector.set(sector, existingSector);
  }
  if (audit.totalValueUsd > 0) {
    for (const value of audit.byTicker.values()) {
      value.pct = (value.valueUsd / audit.totalValueUsd) * 100;
    }
    for (const value of audit.bySector.values()) {
      value.pct = (value.valueUsd / audit.totalValueUsd) * 100;
    }
  }
}

// ---------------------------------------------------------------------------
// Spend cap helper
// ---------------------------------------------------------------------------

async function sumCatalystSpendSince(since: Date): Promise<number> {
  const agg = await prisma.llmCall.aggregate({
    _sum: { costUsd: true },
    where: {
      createdAt: { gte: since },
      purpose: { in: [...CATALYST_PURPOSES] },
    },
  });
  const sum = agg._sum.costUsd;
  return sum === null || sum === undefined ? 0 : Number(sum);
}

// ---------------------------------------------------------------------------
// Mark events processed
// ---------------------------------------------------------------------------

async function markEventsProcessed(events: MarketEvent[]): Promise<void> {
  if (events.length === 0) return;
  const now = new Date();
  await prisma.marketEvent.updateMany({
    where: { id: { in: events.map((e) => e.id) } },
    data: { processedAt: now },
  });
}

// ---------------------------------------------------------------------------
// Confidence inference (matches inferDigestConfidence semantics)
// ---------------------------------------------------------------------------

function inferCatalystConfidence(
  citations: ReadonlyArray<Citation>,
  articles: ReadonlyArray<{ id: number; sourceTier: number }>,
  declared: Confidence,
): Confidence {
  if (citations.length === 0) return Confidence.Low;
  const tierById = new Map<number, number>();
  for (const a of articles) tierById.set(a.id, a.sourceTier);
  let hasTier1 = false;
  let allTier3 = true;
  for (const c of citations) {
    const tier = tierById.get(c.articleId) ?? 2;
    if (tier === 1) hasTier1 = true;
    if (tier !== 3) allTier3 = false;
  }
  const observed: Confidence = hasTier1
    ? Confidence.High
    : allTier3
      ? Confidence.Low
      : Confidence.Medium;
  const rank: Record<Confidence, number> = {
    [Confidence.Low]: 0,
    [Confidence.Medium]: 1,
    [Confidence.High]: 2,
  };
  return rank[declared] < rank[observed] ? declared : observed;
}

// ---------------------------------------------------------------------------
// Prompt rendering
// ---------------------------------------------------------------------------

function buildCatalystSystem(
  settings: UserSettings,
  dominantKind: CatalystKind,
  level: ConjunctionLevel,
): string {
  const budget = Number(settings.monthlyBudget);
  return [
    'You are evaluating a CATALYST-driven buy candidate — a ticker that just produced one or more sharp signals (insider cluster, earnings beat with positive guidance, material 8-K, analyst upgrade).',
    `Dominant signal: ${dominantKind}. Conjunction level: ${level} (1 = single, 2 = corroborated, 3 = full triplet).`,
    `Caps: single position ≤ ${settings.singlePositionCapPct}%, sector ≤ ${settings.sectorCapPct}%. Monthly budget cap: $${budget.toFixed(2)} USD per suggestion.`,
    'You MUST cite tier-1 articles for every load-bearing claim. The wrapper drops citations that do not resolve to real Article rows.',
    'If the evidence does not support a buy at all, emit NO tool call. A clean abstention is preferred over a Low-confidence speculation.',
    'When you DO emit `emit_buy_suggestion`, populate `catalystKind` and `conjunctionLevel` per the values above.',
    `Urgency window: ${URGENCY_HOURS}h — sizing should reflect a ~2-day swing posture, not long-hold conviction.`,
  ].join(' ');
}

interface RenderInput {
  ticker: string;
  events: MarketEvent[];
  conjunction: ConjunctionInfo;
  articles: CatalystArticle[];
  audit: PortfolioAudit;
  settings: UserSettings;
}

function renderCatalystUser(input: RenderInput): string {
  const parts: string[] = [];
  parts.push(`# Catalyst evaluation: ${input.ticker}`);
  parts.push(`- Conjunction level: ${input.conjunction.level}`);
  parts.push(
    `- Distinct event kinds in window: ${[...input.conjunction.distinctKinds].join(', ')}`,
  );
  parts.push('');

  parts.push('## Catalyst events (most recent first)');
  for (const e of input.events) {
    const occurred = e.occurredAt.toISOString();
    const payload = e.payload && typeof e.payload === 'object' ? JSON.stringify(e.payload) : '';
    parts.push(
      `- [eventId: ${e.id}] ${e.kind} · ${occurred}${payload ? ' · ' + truncate(payload, 280) : ''}`,
    );
  }
  parts.push('');

  parts.push('## Portfolio snapshot');
  parts.push(
    `- Total value: $${input.audit.totalValueUsd.toFixed(2)} USD (C$${input.audit.totalValueCad.toFixed(2)} CAD)`,
  );
  if (input.audit.byTicker.size > 0) {
    parts.push('### By position');
    for (const [ticker, info] of input.audit.byTicker) {
      const pct =
        input.audit.totalValueUsd > 0
          ? ((info.valueUsd / input.audit.totalValueUsd) * 100).toFixed(1)
          : '0.0';
      parts.push(
        `- ${ticker}: $${info.valueUsd.toFixed(2)} USD (C$${info.valueCad.toFixed(2)} CAD) · ${pct}%${info.sector ? ` · sector ${info.sector}` : ''}`,
      );
    }
  }
  parts.push('');

  parts.push(`# Article window (tier-1/2 only · ${input.articles.length} articles)`);
  parts.push(
    'Cite by `articleId`. Prefer tier-1 over tier-2. The wrapper rejects citations that do not exist.',
  );
  parts.push('');
  for (const a of input.articles) {
    const body = a.body ? a.body.slice(0, 600) : '';
    const truncatedFlag = a.body && a.body.length > 600 ? ' …[truncated]' : '';
    parts.push(
      `[articleId: ${a.id}] (tier ${a.sourceTier} · ${a.source}${a.domain ? ` · ${a.domain}` : ''})`,
      `  ${a.publishedAt.toISOString()} — ${a.headline}`,
    );
    if (body) parts.push(`  ${body.replace(/\s+/g, ' ').trim()}${truncatedFlag}`);
    parts.push('');
  }

  parts.push('# Instruction');
  parts.push('');
  parts.push('Decide whether the evidence supports a 2-day swing buy of this ticker.');
  parts.push(
    `If yes: emit ONE \`emit_buy_suggestion\` with shares sized to respect single-position + sector caps + the $${Number(input.settings.monthlyBudget).toFixed(2)} USD budget. Set \`catalystKind\` and \`conjunctionLevel\` explicitly. Cite at least one tier-1 article.`,
  );
  parts.push('If no: emit no tool call (the wrapper interprets that as a clean pass).');
  return parts.join('\n');
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + '…';
}

// ---------------------------------------------------------------------------
// Placement guidance
// ---------------------------------------------------------------------------

interface ResolvedPlacement {
  decision: PlacementDecision;
  /** Account.name for the bestAccountId — null when no account picked. */
  accountName: string | null;
}

/**
 * Compute tax-aware placement for `ticker`. Returns null when no TickerMetrics
 * row exists (StockProfile undecidable) or when the loader throws — in either
 * case the suggestion still ships, just without a footer.
 */
async function computePlacement(
  ticker: string,
  log: CatalystLogger,
): Promise<ResolvedPlacement | null> {
  try {
    const [profile, accounts] = await Promise.all([
      loadStockProfile(ticker),
      loadAccountSummaries(),
    ]);
    if (!profile) return null;
    const decision = decidePlacement(profile, accounts);
    let accountName: string | null = null;
    if (decision.bestAccountId !== null) {
      const acct = await prisma.account.findUnique({
        where: { id: decision.bestAccountId },
        select: { name: true },
      });
      accountName = acct?.name ?? null;
    }
    return { decision, accountName };
  } catch (err) {
    log.warn?.(
      { ticker, err: err instanceof Error ? err.message : err },
      '[catalyst] placement lookup failed — proceeding without footer',
    );
    return null;
  }
}

/**
 * Append a one-line placement hint to the model's reasoning. The footer style
 * matches the existing Telegram catalyst template (single emoji prefix, plain
 * prose). When the placement engine cannot pick an account (e.g. user owns
 * only Corporate accounts), the footer falls back to "no account guidance".
 */
function appendPlacementFooter(body: string, placement: ResolvedPlacement | null): string {
  if (!placement) return body;
  const { decision, accountName } = placement;
  if (decision.bestAccountId === null) {
    return `${body}\n📍 No account guidance available.`;
  }
  const acctType: AccountType | undefined = decision.rankedAccountTypes[0];
  const label = accountName
    ? `${accountName}${acctType ? ` (${acctType})` : ''}`
    : (acctType ?? 'preferred account');
  return `${body}\n📍 Best account: ${label} — ${decision.rationale}`;
}

// ---------------------------------------------------------------------------
// Goal-fit footer
// ---------------------------------------------------------------------------

/** Only surface high-confidence matches in the footer. */
const GOAL_FIT_THRESHOLD = 60;
/** Hard cap on footer lines to avoid clutter when many goals fit. */
const GOAL_FIT_MAX_LINES = 2;

/**
 * Look up active goals whose recommended-security profile fits `ticker`.
 * Swallows loader errors — a goal lookup hiccup must not block the
 * suggestion (which has already cleared every cap + LLM gate).
 */
async function collectGoalMatches(ticker: string, log: CatalystLogger): Promise<GoalMatch[]> {
  try {
    const all = await findFittingGoals(ticker);
    return all.filter((m) => m.fitScore >= GOAL_FIT_THRESHOLD).slice(0, GOAL_FIT_MAX_LINES);
  } catch (err) {
    log.warn?.(
      { ticker, err: err instanceof Error ? err.message : err },
      '[catalyst] findFittingGoals threw — proceeding without goal footer',
    );
    return [];
  }
}

/**
 * Append a 🎯 line per matching goal. Mirrors the `📍 Best account:` style
 * — one emoji prefix, one line per match, plain prose so it lands cleanly
 * in both the dashboard and the Telegram message.
 */
function appendGoalFooter(body: string, matches: ReadonlyArray<GoalMatch>): string {
  if (matches.length === 0) return body;
  const lines = matches.map((m) => `🎯 Fits your "${m.goalName}" goal — ${m.reason}`);
  return `${body}\n${lines.join('\n')}`;
}

// Re-export key types from db so callers can import EventKind through this
// module (ergonomic — they don't need a separate db import for type-only uses).
export type { Insight };
