/**
 * Chat retrieval pipeline.
 *
 * Pulls together the per-message context for the chat endpoint:
 *   - Article + ThesisEvaluation semantic hits (via an optional embedding
 *     adapter supplied by the private embedder client).
 *   - Latest DiscoveryScore + signal breakdown.
 *   - TickerMetrics (valuation / margin / growth snapshot).
 *   - FundamentalsSnapshot (last 4 quarters of revenue / net income / EPS).
 *   - Recent MarketEvent rows (last 60 days).
 *   - 30d / 6mo / 1y price summary derived from DailyBar.
 *   - Omniscient app-state sections: accounts, goals, watchlist, insights,
 *     system health (job runs + LLM spend + kill switch), user settings, and
 *     last 5 ChatMessage turns of prior conversation. Each section distinguishes
 *     a confirmed empty result from a failed lookup so the model never turns a
 *     database outage into a false "you don't have any X" claim.
 *
 * All Prisma queries run inside one `Promise.all` so the per-request retrieval
 * stays tight. Ticker scope is capped to 5 (mentioned-first, then held) to keep
 * the formatted block under ~5k tokens for a typical 5-ticker query.
 *
 * The output of `formatRetrievedBlock` is concatenated AFTER the cached system
 * prompt in route.ts — meaning the cache prefix stays stable across messages
 * even though this block changes per request.
 *
 * Formatting rules — DO NOT REGRESS:
 *   - Discovery breakdown is rendered as a per-component table. Compressing it
 *     into a single comma-separated line caused the model to silently drop
 *     low-magnitude rows (insider=-1, filings=0.67, news=5.57, etc.) — keep
 *     every component on its own row with a qualitative reading.
 *   - MarketEvent payloads are unpacked per `kind` so concrete names + dollar
 *     amounts + dates surface in the prompt. Stringified-JSON dumps led the
 *     model to skip insider clusters and 8-Ks even when they were present.
 *   - When the user's message contains a numeric % that disagrees with the
 *     computed 30d return, we surface the discrepancy inline.
 *   - Omniscient sections (accounts / goals / watchlist / system health /
 *     settings) ALWAYS render. Confirmed-empty and unavailable states use
 *     different copy; do not collapse those states.
 */

import {
  prisma,
  startOfZonedDay,
  startOfZonedMonth,
  type DiscoveryScore,
  type FundamentalsSnapshot,
  type GoalStrategy,
  type MarketEvent,
  type TickerMetrics,
} from '@vantage/db';
import {
  computeProgress,
  deriveRiskTolerance,
  loadIncomeYieldOverrides,
  loadLatestDiscoveryScoresByTicker,
  recommendAccount,
  recommendSecurities,
  loadTopDiscoveryPicks,
  CURATED_POOL,
  type GoalInput,
  type GoalType,
  type LinkedPosition,
  type RiskTolerance,
} from '@vantage/core/goals';
import { loadAccountSummaries, type AccountType } from '@vantage/core/accounts';
import { getCachedFxRate, getUsdCadRate } from '@vantage/core/fx';
import { componentLogger } from '@vantage/notify';
import { torontoDateKey } from '@/lib/marketTime';

const log = componentLogger('web/lib/chat-retrieval');

// ---------------------------------------------------------------------------
// Embedding module contract (mirrors the one in route.ts)
// ---------------------------------------------------------------------------

export interface ArticleHit {
  id: number;
  headline: string;
  url: string;
  publishedAt: Date;
  tickers: string[];
  distance: number;
}

export interface ThesisHit {
  id: number;
  thesisId: number;
  rationale: string;
  newStatus: string;
  createdAt: Date;
  distance: number;
}

export interface EmbedModule {
  embed: (text: string) => Promise<number[]>;
  searchArticles: (
    q: number[],
    o: { k: number; tickers?: string[]; sinceDays?: number },
  ) => Promise<ArticleHit[]>;
  searchThesisEvaluations: (
    q: number[],
    o: { k: number; tickers?: string[]; sinceDays?: number },
  ) => Promise<ThesisHit[]>;
}

// ---------------------------------------------------------------------------
// Structured context shapes
// ---------------------------------------------------------------------------

export interface DiscoveryScoreContext {
  ticker: string;
  score: number;
  computedAt: Date;
  breakdown: Record<string, number>;
}

export interface TickerMetricsContext {
  ticker: string;
  metrics: TickerMetrics;
}

export interface FundamentalsContext {
  ticker: string;
  rows: FundamentalsSnapshot[];
}

export interface EventContext {
  ticker: string;
  events: MarketEvent[];
}

export interface PriceWindow {
  startClose: number;
  endClose: number;
  changePct: number;
  startDate: Date;
  endDate: Date;
}

export interface PriceSummaryContext {
  ticker: string;
  /** Latest close — same anchor used for all three windows below. */
  lastClose: number;
  lastDate: Date;
  /** 30 trading-day window (≈ 22 bars back). Null when bar count is short. */
  r30: PriceWindow | null;
  /** 6 month window (≈ 126 trading days back). */
  r6mo: PriceWindow | null;
  /** 1 year window (≈ 252 trading days back). */
  r1y: PriceWindow | null;
}

export interface AccountHolding {
  ticker: string;
  shares: number;
  /** Avg cost in the position's NATIVE currency (the field the user entered). */
  avgCost: number;
  /** Currency avgCost is denominated in — keeps chat from misreporting a CAD
   * cost as USD (e.g. "VDY.TO avg cost C$42.10"). */
  currency: 'CAD' | 'USD';
}

export interface AccountContext {
  id: number;
  name: string;
  type: string;
  currency: 'CAD' | 'USD';
  contributionRoomCad: number | null;
  totalValueCad: number;
  positionCount: number;
  goalCount: number;
  archived: boolean;
  /** Open lots in this account with native-currency cost basis. */
  holdings: AccountHolding[];
}

export interface GoalLinkedPositionSummary {
  ticker: string;
  accountName: string;
  allocation: number;
  valueCad: number;
}

export interface GoalContext {
  id: number;
  name: string;
  type: GoalType;
  targetCad: number;
  targetDate: Date | null;
  currentCad: number;
  percentComplete: number;
  onTrack: boolean;
  monthsRemaining: number | null;
  requiredMonthlyCad: number | null;
  accountName: string | null;
  linkedPositions: GoalLinkedPositionSummary[];
  recommendedAccountType: string | null;
  recommendedAccountRationale: string;
  recommendedAccountWarning?: string;
  topPicks: Array<{
    ticker: string;
    name: string;
    kind: 'curated' | 'discovery';
    fitScore: number;
    reason: string;
  }>;
  riskTolerance: RiskTolerance | null;
  /** Optional primary-purpose axis (Income/Growth/Balanced/Preservation). Null when unset. */
  strategy: GoalStrategy | null;
}

export interface WatchlistRow {
  ticker: string;
  addedAt: Date;
  addedBy: string;
  reason: string | null;
}

export interface InsightSummary {
  id: number;
  kind: string;
  title: string;
  ticker: string | null;
  confidence: string;
  status: string;
  triggeredBy: string;
  createdAt: Date;
}

export interface JobRunSummary {
  name: string;
  lastSuccessAt: Date | null;
  lastStatus: string | null;
  lastStartedAt: Date | null;
  metadata: unknown;
}

export interface SystemHealthContext {
  spendTodayUsd: number | null;
  spendMonthUsd: number | null;
  dailyCapUsd: number | null;
  monthlyCapUsd: number | null;
  killSwitch: boolean | null;
  jobs: JobRunSummary[];
}

export interface SettingsContext {
  singlePositionCapPct: number;
  sectorCapPct: number;
  intradayMoveThresholdPct: number;
  passCooldownDays: number;
  perTickerDailyAlertCap: number;
  discoveryMinMcapUsd: number;
  discoveryWeights: unknown;
  timezone: string;
  catalystEnabled: boolean;
  catalystMaxPerDay: number;
  catalystRequireConjunction: boolean;
  catalystDailySpendCapUsd: number;
  exchangesEnabled: string[];
  monthlyBudgetUsd: number;
}

export interface ChatTurn {
  role: string;
  content: string;
  createdAt: Date;
}

export interface ChatRetrievalBundle {
  tickersUsed: string[];
  articleHits: ArticleHit[];
  thesisHits: ThesisHit[];
  discoveryScores: DiscoveryScoreContext[];
  metrics: TickerMetricsContext[];
  fundamentals: FundamentalsContext[];
  events: EventContext[];
  priceSummaries: PriceSummaryContext[];
  // Omniscient app-state sections — always populated (sections render an
  // empty-state message when the underlying table has zero rows so the model
  // still knows the section was checked).
  accounts: AccountContext[];
  goals: GoalContext[];
  watchlist: WatchlistRow[];
  insights: InsightSummary[];
  systemHealth: SystemHealthContext;
  settings: SettingsContext | null;
  recentMessages: ChatTurn[];
  /** Sections whose source query failed. Empty data for these is not evidence
   * that the user has no rows. */
  unavailableSections: ChatContextSection[];
  /** Explicit degraded-data notes, such as fallback FX or cost-basis pricing. */
  retrievalWarnings: string[];
}

export type ChatContextSection =
  | 'articles'
  | 'thesisEvaluations'
  | 'discovery'
  | 'metrics'
  | 'fundamentals'
  | 'events'
  | 'prices'
  | 'accounts'
  | 'accountValuation'
  | 'goals'
  | 'goalRecommendations'
  | 'goalPrices'
  | 'watchlist'
  | 'insights'
  | 'jobs'
  | 'spend'
  | 'settings'
  | 'conversation';

// ---------------------------------------------------------------------------
// Ticker scope helpers
// ---------------------------------------------------------------------------

const MAX_TICKERS = 5;

/**
 * Pick at most 5 tickers to enrich. Order:
 *   1. Tickers explicitly mentioned in the user message.
 *   2. Held tickers (so the assistant always has portfolio context).
 * Dedupes while preserving order.
 */
function selectTickers(mentioned: readonly string[], held: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of [...mentioned, ...held]) {
    const u = t.toUpperCase();
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
    if (out.length >= MAX_TICKERS) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

interface RetrieveOpts {
  message: string;
  threadId: number;
  mentionedTickers: string[];
  heldTickers: string[];
  embedMod: EmbedModule | null;
  queryEmbedding: number[] | null;
  /**
   * When set, the recent-conversation pull excludes ChatMessage rows with
   * createdAt >= this date. Caller passes the timestamp of the just-inserted
   * user message so it doesn't show up in its own context block.
   */
  excludeMessagesAfter?: Date;
}

// Cron jobs whose freshness the chat surfaces to the model. Ordered so the
// most user-visible signals (catalyst, fundamentals, discovery) lead.
const TRACKED_JOBS = [
  'catalyst.run',
  'poll.fundamentals',
  'discover.compute',
  'poll.prices',
  'poll.news',
] as const;

export async function retrieveChatContext(opts: RetrieveOpts): Promise<ChatRetrievalBundle> {
  const tickerFilter = Array.from(
    new Set([...opts.mentionedTickers, ...opts.heldTickers].map((t) => t.toUpperCase())),
  );
  const tickers = selectTickers(opts.mentionedTickers, opts.heldTickers);

  const { embedMod, queryEmbedding } = opts;
  const unavailable = new Set<ChatContextSection>();
  const retrievalWarnings: string[] = [];
  const degraded = <T>(section: ChatContextSection, fallback: T, err: unknown): T => {
    unavailable.add(section);
    log.warn(
      { section, err: err instanceof Error ? err.message : err },
      'chat context section unavailable',
    );
    return fallback;
  };

  const settingsRow = await prisma.userSettings
    .findUnique({ where: { id: 1 } })
    .catch((err) => degraded('settings', null, err));

  // The DiscoveryScore "latest batch" is defined by max(computedAt). Resolve it
  // once and reuse for the per-ticker pull.
  const latestComputedAtPromise = prisma.discoveryScore
    .aggregate({ _max: { computedAt: true } })
    .then((r) => r._max.computedAt)
    .catch((err) => degraded('discovery', null, err));

  const since60d = new Date(Date.now() - 60 * 24 * 3600 * 1000);
  // ~380 calendar days so chat can surface 30d / 6mo / 1y returns from the
  // same DailyBar query (1y ≈ 252 trading days, with cushion for holidays).
  const sincePriceHistory = new Date(Date.now() - 380 * 24 * 3600 * 1000);
  const now = new Date();
  const timezone = settingsRow?.timezone ?? process.env['TZ'] ?? 'America/Toronto';
  const startOfDay = startOfZonedDay(now, timezone);
  const startOfMonth = startOfZonedMonth(now, timezone);
  const curatedTickers = CURATED_POOL.map((security) => security.ticker);
  const goalRecommendationSignalsPromise = Promise.all([
    loadLatestDiscoveryScoresByTicker(curatedTickers).catch((err) =>
      degraded('goalRecommendations', {} as Record<string, number>, err),
    ),
    loadIncomeYieldOverrides(curatedTickers).catch((err) =>
      degraded('goalRecommendations', {} as Record<string, number>, err),
    ),
  ]);

  const [
    articleHits,
    thesisHits,
    latestComputedAt,
    metricsRows,
    fundamentalsRows,
    eventRows,
    priceRows,
    // ---- Omniscient sections ---------------------------------------------
    accountRows,
    accountSummaries,
    goalRows,
    watchlistRows,
    insightRows,
    jobRunResults,
    spendTodayAgg,
    spendMonthAgg,
    recentMessageRows,
    usdToCad,
    goalRecommendationSignals,
  ] = await Promise.all([
    queryEmbedding && embedMod
      ? embedMod
          .searchArticles(queryEmbedding, {
            k: 10,
            tickers: tickerFilter,
            sinceDays: 60,
          })
          .catch((err) => degraded('articles', [] as ArticleHit[], err))
      : Promise.resolve([] as ArticleHit[]),
    queryEmbedding && embedMod
      ? embedMod
          .searchThesisEvaluations(queryEmbedding, {
            k: 5,
            tickers: tickerFilter.length > 0 ? tickerFilter : undefined,
            sinceDays: 90,
          })
          .catch((err) => degraded('thesisEvaluations', [] as ThesisHit[], err))
      : Promise.resolve([] as ThesisHit[]),
    latestComputedAtPromise,
    tickers.length > 0
      ? prisma.tickerMetrics
          .findMany({ where: { ticker: { in: tickers } } })
          .catch((err) => degraded('metrics', [] as TickerMetrics[], err))
      : Promise.resolve([] as TickerMetrics[]),
    tickers.length > 0
      ? prisma.fundamentalsSnapshot
          .findMany({
            where: { ticker: { in: tickers }, periodType: 'Q' },
            orderBy: { periodEnd: 'desc' },
            take: 4 * tickers.length,
          })
          .catch((err) => degraded('fundamentals', [] as FundamentalsSnapshot[], err))
      : Promise.resolve([] as FundamentalsSnapshot[]),
    tickers.length > 0
      ? prisma.marketEvent
          .findMany({
            where: { ticker: { in: tickers }, occurredAt: { gte: since60d } },
            orderBy: { occurredAt: 'desc' },
            take: 5 * tickers.length,
          })
          .catch((err) => degraded('events', [] as MarketEvent[], err))
      : Promise.resolve([] as MarketEvent[]),
    tickers.length > 0
      ? prisma.dailyBar
          .findMany({
            where: { ticker: { in: tickers }, date: { gte: sincePriceHistory } },
            orderBy: { date: 'asc' },
          })
          .catch((err) =>
            degraded(
              'prices',
              [] as Array<{ ticker: string; date: Date; close: { toString(): string } }>,
              err,
            ),
          )
      : Promise.resolve([] as Array<{ ticker: string; date: Date; close: { toString(): string } }>),
    // ---- Accounts: include archived briefly + per-account counts.
    prisma.account
      .findMany({
        include: {
          positions: {
            where: { closedAt: null },
            select: {
              id: true,
              ticker: true,
              shares: true,
              avgCost: true,
              currency: true,
            },
          },
          _count: { select: { goals: true } },
        },
        orderBy: [{ archivedAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
      })
      .catch((err) =>
        degraded(
          'accounts',
          [] as Array<{
            id: number;
            name: string;
            type: string;
            currency: string;
            contributionRoomCad: { toString(): string } | null;
            archivedAt: Date | null;
            positions: Array<{
              id: number;
              ticker: string;
              shares: { toString(): string };
              avgCost: { toString(): string };
              currency: string;
            }>;
            _count: { goals: number };
          }>,
          err,
        ),
      ),
    // AccountSummary[] for the goals engine — uses latest DailyBar × FX so
    // CAD totals stay consistent with /accounts and /goals views.
    loadAccountSummaries().catch((err) =>
      degraded('accountValuation', [] as Awaited<ReturnType<typeof loadAccountSummaries>>, err),
    ),
    // ---- Goals: non-archived only, plus linked positions for progress math.
    prisma.goal
      .findMany({
        where: { archivedAt: null },
        include: {
          account: { select: { id: true, name: true, type: true, currency: true } },
          contributions: {
            include: {
              position: {
                include: {
                  account: {
                    select: { id: true, name: true, type: true, currency: true },
                  },
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      })
      .catch((err) =>
        degraded(
          'goals',
          [] as Array<{
            id: number;
            name: string;
            type: GoalType;
            targetAmountCad: { toString(): string };
            targetDate: Date | null;
            isWithdrawal: boolean;
            riskOverride: RiskTolerance | null;
            strategy: GoalStrategy | null;
            accountId: number | null;
            account: { id: number; name: string; type: string; currency: string } | null;
            contributions: Array<{
              allocation: { toString(): string };
              position: {
                id: number;
                ticker: string;
                shares: { toString(): string };
                avgCost: { toString(): string };
                currency: string;
                accountId: number;
                account: { id: number; name: string; type: string; currency: string };
              };
            }>;
          }>,
          err,
        ),
      ),
    // ---- Watchlist.
    prisma.watchlist.findMany({ orderBy: { addedAt: 'desc' } }).catch((err) =>
      degraded(
        'watchlist',
        [] as Array<{
          id: number;
          ticker: string;
          addedAt: Date;
          reason: string | null;
          addedBy: string;
        }>,
        err,
      ),
    ),
    // ---- Last 20 Insight rows (cap 20 per spec).
    prisma.insight.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }).catch((err) =>
      degraded(
        'insights',
        [] as Array<{
          id: number;
          kind: string;
          title: string;
          actionJson: unknown;
          confidence: string;
          status: string;
          triggeredBy: string;
          createdAt: Date;
        }>,
        err,
      ),
    ),
    // ---- Last successful run per tracked cron, in parallel within the outer
    // Promise.all. Each lookup is `findFirst` on (name, status=succeeded).
    Promise.all(
      TRACKED_JOBS.map(async (name) => {
        const [lastSuccess, lastAny] = await Promise.all([
          prisma.jobRun
            .findFirst({
              where: { name, status: 'succeeded' },
              orderBy: { endedAt: 'desc' },
            })
            .catch((err) => degraded('jobs', null, err)),
          prisma.jobRun
            .findFirst({
              where: { name },
              orderBy: { startedAt: 'desc' },
            })
            .catch((err) => degraded('jobs', null, err)),
        ]);
        return {
          name,
          lastSuccessAt: lastSuccess?.endedAt ?? null,
          lastStatus: lastAny?.status ?? null,
          lastStartedAt: lastAny?.startedAt ?? null,
          metadata: lastSuccess?.metadata ?? lastAny?.metadata ?? null,
        } satisfies JobRunSummary;
      }),
    ),
    // ---- LLM spend aggregates: today + month-to-date.
    prisma.llmCall
      .aggregate({
        _sum: { costUsd: true },
        where: { createdAt: { gte: startOfDay } },
      })
      .catch((err) => degraded('spend', { _sum: { costUsd: null } }, err)),
    prisma.llmCall
      .aggregate({
        _sum: { costUsd: true },
        where: { createdAt: { gte: startOfMonth } },
      })
      .catch((err) => degraded('spend', { _sum: { costUsd: null } }, err)),
    // ---- Prior turns in this thread. Filter by `excludeMessagesAfter` so the
    // current user message (already persisted) doesn't show up in its own
    // context block. Pull desc + slice so we always get the freshest 5.
    prisma.chatMessage
      .findMany({
        where: {
          threadId: opts.threadId,
          ...(opts.excludeMessagesAfter ? { createdAt: { lt: opts.excludeMessagesAfter } } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: 5,
      })
      .catch((err) =>
        degraded(
          'conversation',
          [] as Array<{ id: number; role: string; content: string; createdAt: Date }>,
          err,
        ),
      ),
    // FX rate — used to convert USD account/position totals to CAD. The helper
    // has a configured fallback and exposes its source after resolution.
    getUsdCadRate(),
    goalRecommendationSignalsPromise,
  ]);

  const [goalDiscoveryScoreByTicker, goalIncomeYieldByTicker] = goalRecommendationSignals;

  const fxState = getCachedFxRate();
  if (fxState?.source === 'fallback') {
    retrievalWarnings.push(
      `USD/CAD conversion is using the configured fallback rate ${usdToCad.toFixed(4)} because live FRED data is unavailable. CAD account and goal values are approximate.`,
    );
  }

  // ---- DiscoveryScore: only loaded if we know the latest batch and have tickers.
  const discoveryScoreRows: DiscoveryScore[] =
    latestComputedAt && tickers.length > 0
      ? await prisma.discoveryScore
          .findMany({
            where: { ticker: { in: tickers }, computedAt: latestComputedAt },
          })
          .catch((err) => degraded('discovery', [] as DiscoveryScore[], err))
      : [];

  // ---- Shape the per-ticker structures.
  const discoveryScores: DiscoveryScoreContext[] = discoveryScoreRows.map((r) => ({
    ticker: r.ticker,
    score: r.score,
    computedAt: r.computedAt,
    breakdown: coerceBreakdown(r.signalBreakdown),
  }));

  const metrics: TickerMetricsContext[] = metricsRows.map((m) => ({
    ticker: m.ticker,
    metrics: m,
  }));

  const fundamentals: FundamentalsContext[] = tickers
    .map((t) => ({
      ticker: t,
      rows: fundamentalsRows.filter((r) => r.ticker === t).slice(0, 4),
    }))
    .filter((f) => f.rows.length > 0);

  const events: EventContext[] = tickers
    .map((t) => ({
      ticker: t,
      events: eventRows.filter((e) => e.ticker === t),
    }))
    .filter((e) => e.events.length > 0);

  const priceSummaries: PriceSummaryContext[] = tickers
    .map((t) => {
      // Rows arrived ascending; flip so index 0 = most recent. Trading-day
      // offsets: 30d ≈ 22 bars, 6mo ≈ 126, 1y ≈ 252.
      const desc = priceRows
        .filter((b) => b.ticker === t)
        .slice()
        .reverse();
      if (desc.length < 2) return null;
      const last = desc[0]!;
      const lastClose = Number(last.close.toString());
      if (!Number.isFinite(lastClose) || lastClose <= 0) return null;
      const lastDate = last.date;

      const buildWindow = (idx: number): PriceWindow | null => {
        const ref = desc[idx];
        if (!ref) return null;
        const startClose = Number(ref.close.toString());
        if (!Number.isFinite(startClose) || startClose <= 0) return null;
        return {
          startClose,
          endClose: lastClose,
          changePct: ((lastClose - startClose) / startClose) * 100,
          startDate: ref.date,
          endDate: lastDate,
        };
      };

      return {
        ticker: t,
        lastClose,
        lastDate,
        r30: buildWindow(21),
        r6mo: buildWindow(125),
        r1y: buildWindow(251),
      } satisfies PriceSummaryContext;
    })
    .filter((p): p is PriceSummaryContext => p !== null);

  // ---- Build a latest-close map for any held / linked ticker so accounts +
  // goals share the same price source. Pulled lazily via getLatestBarsForTickers
  // would be cheaper, but the universe of tickers across accounts/goals can be
  // large — we already have per-ticker bars for the 5-ticker scope. Anything
  // outside that scope falls back to avgCost (mirrors loadAccountSummaries).
  const latestCloseByTicker = new Map<string, number>();
  for (const t of tickers) {
    const bars = priceRows.filter((b) => b.ticker === t);
    if (bars.length === 0) continue;
    const close = Number(bars[bars.length - 1]!.close.toString());
    if (Number.isFinite(close)) latestCloseByTicker.set(t, close);
  }
  // Pull latest bars for every account+goal ticker not already in scope. This
  // is a single DistinctOn query (getLatestBarsForTickers semantics) — but we
  // already issued it indirectly inside loadAccountSummaries. To avoid the
  // double-fetch we lean on the AccountSummary totals for account values, and
  // recompute goal progress using the linked positions' bars below.
  const goalTickers = Array.from(
    new Set(goalRows.flatMap((g) => g.contributions.map((c) => c.position.ticker.toUpperCase()))),
  );
  const missingTickers = goalTickers.filter((t) => !latestCloseByTicker.has(t));
  if (missingTickers.length > 0) {
    try {
      const moreBars = await prisma.dailyBar.findMany({
        where: { ticker: { in: missingTickers } },
        orderBy: { date: 'desc' },
        distinct: ['ticker'],
        select: { ticker: true, close: true },
      });
      for (const r of moreBars) {
        const n = Number(r.close.toString());
        if (Number.isFinite(n)) latestCloseByTicker.set(r.ticker.toUpperCase(), n);
      }
    } catch (err) {
      unavailable.add('goalPrices');
      log.warn(
        { err, tickerCount: missingTickers.length },
        'goal price lookup failed; using average costs',
      );
    }
  }
  const goalTickersUsingCostBasis = goalTickers.filter((t) => !latestCloseByTicker.has(t));
  if (goalTickersUsingCostBasis.length > 0) {
    retrievalWarnings.push(
      `Goal progress uses average cost instead of a current close for: ${goalTickersUsingCostBasis.slice(0, 10).join(', ')}${goalTickersUsingCostBasis.length > 10 ? ', ...' : ''}.`,
    );
  }
  if (unavailable.has('accountValuation')) {
    retrievalWarnings.push(
      'Account valuation rollups were unavailable; any account totals below are reconstructed from available closes and may fall back to average cost.',
    );
  }

  // ---- Accounts: prefer AccountSummary totals (they already merge bars + FX
  // and skip closed positions), fall back to avgCost-derived for anything the
  // summaries dropped (e.g. Corporate accounts, which loadAccountSummaries
  // intentionally excludes).
  const summaryById = new Map(accountSummaries.map((a) => [a.id, a]));
  const accounts: AccountContext[] = accountRows.map((a) => {
    const summary = summaryById.get(a.id);
    let totalCad: number;
    if (summary) {
      totalCad = summary.currentValueCad;
    } else {
      // Manual roll-up for accounts the summary dropped (Corporate). Convert
      // each listing independently because a CAD account can hold USD stocks.
      let cadTotal = 0;
      for (const p of a.positions) {
        const shares = Number(p.shares.toString());
        if (!Number.isFinite(shares) || shares <= 0) continue;
        const close =
          latestCloseByTicker.get(p.ticker.toUpperCase()) ?? Number(p.avgCost.toString());
        if (!Number.isFinite(close) || close <= 0) continue;
        const nativeValue = shares * close;
        cadTotal += p.currency === 'CAD' ? nativeValue : nativeValue * usdToCad;
      }
      totalCad = cadTotal;
    }
    return {
      id: a.id,
      name: a.name,
      type: a.type,
      currency: a.currency === 'USD' ? 'USD' : 'CAD',
      contributionRoomCad:
        a.contributionRoomCad !== null ? Number(a.contributionRoomCad.toString()) : null,
      totalValueCad: Math.round(totalCad * 100) / 100,
      positionCount: a.positions.length,
      goalCount: a._count.goals,
      archived: a.archivedAt !== null,
      holdings: a.positions.map((p) => ({
        ticker: p.ticker,
        shares: Number(p.shares.toString()),
        avgCost: Number(p.avgCost.toString()),
        currency: p.currency === 'CAD' ? 'CAD' : 'USD',
      })),
    } satisfies AccountContext;
  });

  // ---- Goals: rich per-goal computation. We hand the engine a sync `accounts`
  // array (already loaded above) so recommendAccount + recommendSecurities run
  // pure. Top picks are capped at 3 to keep the section tight. Each goal may
  // await its own discovery-pick fetch (only for High/Aggressive risk), so the
  // map is wrapped in Promise.all.
  const goals: GoalContext[] = await Promise.all(
    goalRows.map(async (g) => {
      const goalInput: GoalInput = {
        id: g.id,
        name: g.name,
        type: g.type,
        targetAmountCad: Number(g.targetAmountCad.toString()),
        targetDate: g.targetDate,
        isWithdrawal: g.isWithdrawal,
        riskOverride: g.riskOverride,
        strategy: g.strategy,
        accountId: g.accountId,
      };
      const linked: LinkedPosition[] = g.contributions.map((c) => {
        const upper = c.position.ticker.toUpperCase();
        const averageCost = Number(c.position.avgCost.toString());
        const close =
          latestCloseByTicker.get(upper) ??
          (Number.isFinite(averageCost) && averageCost > 0 ? averageCost : null);
        const positionCurrency: 'CAD' | 'USD' = c.position.currency === 'CAD' ? 'CAD' : 'USD';
        return {
          positionId: c.position.id,
          ticker: upper,
          shares: Number(c.position.shares.toString()),
          latestClose: close,
          currency: positionCurrency,
          allocation: Number(c.allocation.toString()),
          accountId: c.position.accountId,
          accountType: c.position.account.type,
        };
      });
      const progress = computeProgress(goalInput, linked, usdToCad);
      const recAccount = recommendAccount(goalInput, accountSummaries);
      // Goal-linked account wins; fall back to top-ranked recommendation when
      // the goal isn't yet tied to a specific account row.
      const effectiveAccountType: AccountType | undefined = g.account?.type
        ? (g.account.type as AccountType)
        : recAccount.rankedTypes[0]
          ? (recAccount.rankedTypes[0] as AccountType)
          : undefined;
      let topPicks: GoalContext['topPicks'] = [];
      try {
        // Mirror /goals/[id] page: High/Aggressive goals pull discovery picks so
        // the recs match what the dashboard shows. Without this, chat sees only
        // curated ETFs while the page shows individual high-conviction names.
        const risk = deriveRiskTolerance(goalInput);
        const wantsDiscovery = risk === 'High' || risk === 'Aggressive';
        const discoveryPicks = wantsDiscovery
          ? await loadTopDiscoveryPicks({
              limit: 8,
              excludeTickers: CURATED_POOL.map((c) => c.ticker),
              risk,
              ...(effectiveAccountType ? { accountType: effectiveAccountType } : {}),
              ...(goalInput.strategy ? { strategy: goalInput.strategy } : {}),
            })
          : [];
        // Use the same `limit: 10` the goal-detail page uses so the engine's
        // satellite-quota math gives the same mix of curated vs discovery.
        // We slice to top 3 AFTER the engine ranks — that way chat and the
        // dashboard show the same top picks for the same goal.
        const recs = recommendSecurities(goalInput, {
          limit: wantsDiscovery ? 10 : 5,
          ...(effectiveAccountType ? { goalAccountType: effectiveAccountType } : {}),
          ...(discoveryPicks.length > 0 ? { discoveryPicks } : {}),
          ...(Object.keys(goalDiscoveryScoreByTicker).length > 0
            ? { discoveryScoreByTicker: goalDiscoveryScoreByTicker }
            : {}),
          ...(Object.keys(goalIncomeYieldByTicker).length > 0
            ? { incomeYieldByTicker: goalIncomeYieldByTicker }
            : {}),
        });
        topPicks = recs.slice(0, 3).map((r) => ({
          ticker: r.security.ticker,
          name: r.security.name,
          kind: r.kind,
          fitScore: r.fitScore,
          reason: r.reason.length > 220 ? `${r.reason.slice(0, 220)}…` : r.reason,
        }));
      } catch (err) {
        unavailable.add('goalRecommendations');
        log.warn({ err, goalId: g.id }, 'goal recommendations unavailable in chat context');
        topPicks = [];
      }

      const linkedPositions: GoalLinkedPositionSummary[] = linked.map((p) => {
        const native = (p.latestClose ?? 0) * p.shares * p.allocation;
        const cad = p.currency === 'USD' ? native * usdToCad : native;
        const dbRow = g.contributions.find((c) => c.position.id === p.positionId);
        return {
          ticker: p.ticker,
          accountName: dbRow?.position.account.name ?? '',
          allocation: p.allocation,
          valueCad: Math.round(cad * 100) / 100,
        };
      });

      // Re-derive risk via the same engine helper that drove the recommendation.
      let risk: RiskTolerance | null = null;
      try {
        risk = deriveRiskTolerance(goalInput);
      } catch (err) {
        log.warn({ err, goalId: g.id }, 'goal risk derivation failed in chat context');
        unavailable.add('goalRecommendations');
      }

      return {
        id: g.id,
        name: g.name,
        type: g.type,
        targetCad: goalInput.targetAmountCad,
        targetDate: g.targetDate,
        currentCad: Math.round(progress.currentValueCad * 100) / 100,
        percentComplete: Math.round(progress.percentComplete * 10) / 10,
        onTrack: progress.onTrack,
        monthsRemaining: progress.monthsRemaining,
        requiredMonthlyCad:
          progress.requiredMonthlyCad !== null
            ? Math.round(progress.requiredMonthlyCad * 100) / 100
            : null,
        accountName: g.account?.name ?? null,
        linkedPositions,
        recommendedAccountType: recAccount.rankedTypes[0] ?? null,
        recommendedAccountRationale: recAccount.rationale,
        ...(recAccount.warning ? { recommendedAccountWarning: recAccount.warning } : {}),
        topPicks,
        riskTolerance: risk,
        strategy: g.strategy,
      } satisfies GoalContext;
    }),
  );

  const watchlist: WatchlistRow[] = watchlistRows.map((w) => ({
    ticker: w.ticker,
    addedAt: w.addedAt,
    addedBy: w.addedBy,
    reason: w.reason,
  }));

  const insights: InsightSummary[] = insightRows.map((i) => ({
    id: i.id,
    kind: String(i.kind),
    title: i.title,
    ticker: extractInsightTicker(i.actionJson),
    confidence: String(i.confidence),
    status: String(i.status),
    triggeredBy: i.triggeredBy,
    createdAt: i.createdAt,
  }));

  const systemHealth: SystemHealthContext = {
    spendTodayUsd: unavailable.has('spend') ? null : Number(spendTodayAgg._sum.costUsd ?? 0),
    spendMonthUsd: unavailable.has('spend') ? null : Number(spendMonthAgg._sum.costUsd ?? 0),
    dailyCapUsd: settingsRow ? Number(settingsRow.dailySpendCapUsd) : null,
    monthlyCapUsd: settingsRow ? Number(settingsRow.monthlySpendCapUsd) : null,
    killSwitch: settingsRow?.killSwitch ?? null,
    jobs: jobRunResults,
  };

  const settings: SettingsContext | null = settingsRow
    ? {
        singlePositionCapPct: settingsRow.singlePositionCapPct,
        sectorCapPct: settingsRow.sectorCapPct,
        intradayMoveThresholdPct: settingsRow.intradayMoveThresholdPct,
        passCooldownDays: settingsRow.passCooldownDays,
        perTickerDailyAlertCap: settingsRow.perTickerDailyAlertCap,
        discoveryMinMcapUsd: Number(settingsRow.discoveryMinMcapUsd),
        discoveryWeights: settingsRow.discoveryWeights,
        timezone: settingsRow.timezone,
        catalystEnabled: settingsRow.catalystEnabled,
        catalystMaxPerDay: settingsRow.catalystMaxPerDay,
        catalystRequireConjunction: settingsRow.catalystRequireConjunction,
        catalystDailySpendCapUsd: Number(settingsRow.catalystDailySpendCapUsd),
        exchangesEnabled: Array.isArray(settingsRow.exchangesEnabled)
          ? (settingsRow.exchangesEnabled as unknown[]).map((x) => String(x))
          : [],
        monthlyBudgetUsd: Number(settingsRow.monthlyBudget),
      }
    : null;

  // recentMessageRows came back desc — reverse so the formatted block reads
  // oldest → newest the way humans expect.
  const recentMessages: ChatTurn[] = recentMessageRows
    .slice()
    .reverse()
    .map((m) => ({
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
    }));

  return {
    tickersUsed: tickers,
    articleHits,
    thesisHits,
    discoveryScores,
    metrics,
    fundamentals,
    events,
    priceSummaries,
    accounts,
    goals,
    watchlist,
    insights,
    systemHealth,
    settings,
    recentMessages,
    unavailableSections: [...unavailable].sort(),
    retrievalWarnings,
  };
}

/**
 * Pull a ticker hint out of Insight.actionJson if present. The action blob is
 * schema-shaped as `{ type, ticker, shares, targetTicker?, priceSnapshot }`
 * but only the buy/rotate kinds populate it — alerts and thesis updates leave
 * it null. Returns null when no ticker is recoverable.
 */
function extractInsightTicker(action: unknown): string | null {
  if (!action || typeof action !== 'object') return null;
  const obj = action as Record<string, unknown>;
  const t = obj['ticker'];
  if (typeof t === 'string' && t.length > 0) return t.toUpperCase();
  const tt = obj['targetTicker'];
  if (typeof tt === 'string' && tt.length > 0) return tt.toUpperCase();
  return null;
}

function coerceBreakdown(input: unknown): Record<string, number> {
  if (!input || typeof input !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'string') {
      const n = Number(v);
      if (Number.isFinite(n)) out[k] = n;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const ISO_DATE = (d: Date): string => d.toISOString().slice(0, 10);
const ET_DATE = (d: Date): string => torontoDateKey(d);

function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `${n.toFixed(digits)}%`;
}

function fmtDecimal(v: { toString(): string } | null | undefined, digits = 2): string {
  if (v === null || v === undefined) return '—';
  const n = Number(v.toString());
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

function fmtMoneyShort(v: { toString(): string } | null | undefined): string {
  if (v === null || v === undefined) return '—';
  const n = Number(v.toString());
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

/** CAD dollar formatter — full precision with thousands separators. */
function fmtCad(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `C$${n.toLocaleString('en-CA', { maximumFractionDigits: 0 })}`;
}

/** USD dollar formatter — 2dp, used for LLM spend lines. */
function fmtUsdMoney(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `$${n.toFixed(2)}`;
}

/** USD short-form for big numbers (market cap floor etc.). */
function fmtUsdMoneyShort(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return fmtMoneyShort({ toString: () => String(n) });
}

/**
 * Relative time like "12 min ago" / "3 hr ago" / "today" / "2d ago".
 * Used in the system-health block so the model can quickly tell whether a
 * cron is current. Always anchored on `Date.now()`.
 */
function fmtRelativeTime(d: Date): string {
  const ms = Date.now() - d.getTime();
  if (!Number.isFinite(ms) || ms < 0) return d.toISOString();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const days = Math.floor(hr / 24);
  if (days === 1) return '1d ago';
  return `${days}d ago`;
}

/**
 * Pull a short human-readable summary out of a JobRun.metadata blob. The
 * worker writes per-job metadata shapes; common keys we surface include
 * `count`, `tickersScored`, `tickers`, `processed`. Anything we don't
 * recognise is rendered as a truncated JSON dump.
 */
function describeJobMeta(meta: unknown): string {
  if (!meta || typeof meta !== 'object') return '';
  const obj = meta as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of [
    'count',
    'tickersScored',
    'tickers',
    'processed',
    'inserted',
    'updated',
    'symbols',
    'articles',
    'bars',
    'fundamentals',
    'rows',
  ]) {
    const v = obj[k];
    if (typeof v === 'number') parts.push(`${v} ${k}`);
  }
  if (parts.length > 0) return parts.join(', ');
  const json = JSON.stringify(obj);
  return json.length > 120 ? `${json.slice(0, 120)}…` : json;
}

export interface FormatOpts {
  userMessage?: string;
}

export function formatRetrievedBlock(bundle: ChatRetrievalBundle, opts: FormatOpts = {}): string {
  const sections: string[] = ['# Retrieved context'];
  const unavailable = new Set(bundle.unavailableSections);

  if (unavailable.size > 0) {
    sections.push(
      '',
      '## Retrieval status',
      `Unavailable sections: ${[...unavailable].join(', ')}. Do not infer that these sections are empty, do not substitute defaults, and tell the user when an answer depends on unavailable context.`,
    );
  }
  if (bundle.retrievalWarnings.length > 0) {
    sections.push('', '## Data-quality warnings');
    for (const warning of bundle.retrievalWarnings) sections.push(`- ${warning}`);
  }

  // ---- Omniscient app-state sections --------------------------------------
  // These render FIRST so the model sees user-owned state (accounts, goals,
  // watchlist, system health, settings, prior conversation) before per-ticker
  // enrichment. Each section ALWAYS renders, even when empty — the empty-state
  // copy tells the model the section was checked so it can answer "you don't
  // have any X yet" instead of refusing.

  // Accounts
  sections.push('', '## Your accounts');
  if (unavailable.has('accounts')) {
    sections.push(
      '(account rows are unavailable for this response; do not claim there are no accounts)',
    );
  } else if (bundle.accounts.length === 0) {
    sections.push("You don't have any accounts on file yet.");
  } else {
    sections.push(
      '| Account | Type | Currency | Total CAD | Room CAD | Positions | Goals | Archived |',
    );
    sections.push(
      '|---------|------|----------|-----------|----------|-----------|-------|----------|',
    );
    for (const a of bundle.accounts) {
      sections.push(
        `| ${a.name} | ${a.type} | ${a.currency} | ${fmtCad(a.totalValueCad)} | ${
          a.contributionRoomCad !== null ? fmtCad(a.contributionRoomCad) : '—'
        } | ${a.positionCount} | ${a.goalCount} | ${a.archived ? 'yes' : 'no'} |`,
      );
    }
    // Per-account holdings with native-currency cost basis. avgCost is shown in
    // the position's own currency (e.g. C$42.10 for VDY.TO) so the model never
    // reports a CAD cost as USD.
    for (const a of bundle.accounts) {
      if (a.holdings.length === 0) continue;
      const lots = a.holdings
        .map((h) => {
          const sym = h.currency === 'CAD' ? 'C$' : '$';
          return `${h.ticker} ${h.shares} @ ${sym}${h.avgCost.toFixed(2)} ${h.currency}`;
        })
        .join(', ');
      sections.push(`- ${a.name} holdings: ${lots}`);
    }
  }

  // Goals
  sections.push('', '## Your goals');
  if (unavailable.has('goals')) {
    sections.push('(goal rows are unavailable for this response; do not claim there are no goals)');
  } else if (bundle.goals.length === 0) {
    sections.push("You don't have any goals set up yet.");
  } else {
    for (const g of bundle.goals) {
      const byDate = g.targetDate ? ISO_DATE(g.targetDate) : 'open-ended';
      const trackTag = g.onTrack ? 'on track' : 'behind';
      const strategyTag = g.strategy ? ` · strategy ${g.strategy}` : '';
      const headline =
        `### ${g.name} — ${g.type}` +
        ` · target ${fmtCad(g.targetCad)} by ${byDate}` +
        ` · current ${fmtCad(g.currentCad)} (${g.percentComplete.toFixed(1)}%, ${trackTag})` +
        ` · risk ${g.riskTolerance ?? 'unavailable'}` +
        strategyTag;
      sections.push('', headline);
      if (g.monthsRemaining !== null && g.requiredMonthlyCad !== null) {
        sections.push(
          `- ${g.monthsRemaining}mo remaining · need ${fmtCad(g.requiredMonthlyCad)}/mo to close the gap`,
        );
      }
      sections.push(
        `- Linked positions: ${g.linkedPositions.length}${
          g.linkedPositions.length > 0
            ? ` (${g.linkedPositions
                .slice(0, 5)
                .map(
                  (p) =>
                    `${p.ticker}@${p.accountName} ${Math.round(p.allocation * 100)}% = ${fmtCad(p.valueCad)}`,
                )
                .join(', ')})`
            : ''
        }`,
      );
      sections.push(
        `- Account: ${g.accountName ?? '(none linked)'} · recommended: ${
          g.recommendedAccountType ?? '—'
        }`,
      );
      if (g.recommendedAccountWarning) {
        sections.push(`- Warning: ${g.recommendedAccountWarning}`);
      }
      if (g.topPicks.length > 0) {
        const picks = g.topPicks
          .map((p) => `${p.ticker} (${p.kind}, fit ${p.fitScore})`)
          .join(', ');
        sections.push(`- Top picks: ${picks}`);
      } else if (unavailable.has('goalRecommendations')) {
        sections.push('- Top picks: unavailable for this response');
      }
    }
  }

  // Watchlist
  sections.push('', '## Your watchlist');
  if (unavailable.has('watchlist')) {
    sections.push('(watchlist data is unavailable for this response; do not claim it is empty)');
  } else if (bundle.watchlist.length === 0) {
    sections.push("You don't have anything on your watchlist yet.");
  } else {
    for (const w of bundle.watchlist) {
      const reason = w.reason ? ` — ${w.reason}` : '';
      sections.push(`- ${w.ticker} (added ${ET_DATE(w.addedAt)} by ${w.addedBy})${reason}`);
    }
  }

  // Insights
  sections.push('', '## Recent insights / alerts (last 20)');
  if (unavailable.has('insights')) {
    sections.push('(insight data is unavailable for this response; do not claim no alerts exist)');
  } else if (bundle.insights.length === 0) {
    sections.push('(no insights have been emitted yet)');
  } else {
    for (const i of bundle.insights) {
      const tickerTag = i.ticker ? ` [${i.ticker}]` : '';
      sections.push(
        `- ${ET_DATE(i.createdAt)} ${i.kind}${tickerTag} — ${i.title} (confidence: ${i.confidence}, status: ${i.status}, trigger: ${i.triggeredBy})`,
      );
    }
  }

  // System health
  sections.push('', '## System health');
  sections.push(
    `- Today's spend: ${bundle.systemHealth.spendTodayUsd === null ? 'unavailable' : fmtUsdMoney(bundle.systemHealth.spendTodayUsd)} of ${bundle.systemHealth.dailyCapUsd === null ? 'unavailable' : fmtUsdMoney(bundle.systemHealth.dailyCapUsd)} daily cap`,
  );
  sections.push(
    `- Month spend: ${bundle.systemHealth.spendMonthUsd === null ? 'unavailable' : fmtUsdMoney(bundle.systemHealth.spendMonthUsd)} of ${bundle.systemHealth.monthlyCapUsd === null ? 'unavailable' : fmtUsdMoney(bundle.systemHealth.monthlyCapUsd)} monthly cap`,
  );
  sections.push(
    `- Kill switch: ${bundle.systemHealth.killSwitch === null ? 'unavailable' : bundle.systemHealth.killSwitch ? 'ON' : 'OFF'}`,
  );
  if (unavailable.has('jobs')) {
    sections.push('- Job history: unavailable for this response');
  }
  for (const j of unavailable.has('jobs') ? [] : bundle.systemHealth.jobs) {
    if (j.lastSuccessAt) {
      const ago = fmtRelativeTime(j.lastSuccessAt);
      const metaTag = j.metadata ? ` — ${describeJobMeta(j.metadata)}` : '';
      sections.push(
        `- ${j.name}: last success ${ago} (${j.lastSuccessAt.toISOString()})${metaTag}`,
      );
    } else if (j.lastStartedAt) {
      sections.push(
        `- ${j.name}: never succeeded (last attempt ${j.lastStatus ?? 'unknown'} at ${j.lastStartedAt.toISOString()})`,
      );
    } else {
      sections.push(`- ${j.name}: no runs recorded`);
    }
  }

  // User settings
  sections.push('', '## Your settings');
  if (unavailable.has('settings')) {
    sections.push('(settings are unavailable for this response; do not substitute defaults)');
  } else if (!bundle.settings) {
    sections.push('(settings row not initialized)');
  } else {
    const s = bundle.settings;
    sections.push('| Setting | Value |');
    sections.push('|---------|-------|');
    sections.push(`| Single-position cap | ${s.singlePositionCapPct}% |`);
    sections.push(`| Sector cap | ${s.sectorCapPct}% |`);
    sections.push(`| Intraday move threshold | ${s.intradayMoveThresholdPct}% |`);
    sections.push(`| Pass cooldown | ${s.passCooldownDays} days |`);
    sections.push(`| Per-ticker daily alert cap | ${s.perTickerDailyAlertCap} |`);
    sections.push(`| Discovery min market cap | ${fmtUsdMoneyShort(s.discoveryMinMcapUsd)} |`);
    sections.push(
      `| Discovery weights | ${s.discoveryWeights ? JSON.stringify(s.discoveryWeights) : '(defaults)'} |`,
    );
    sections.push(`| Timezone | ${s.timezone} |`);
    sections.push(`| Monthly budget | ${fmtUsdMoney(s.monthlyBudgetUsd)} |`);
    sections.push(`| Catalyst engine | ${s.catalystEnabled ? 'ON' : 'OFF'} |`);
    sections.push(`| Catalyst max/day | ${s.catalystMaxPerDay} |`);
    sections.push(
      `| Catalyst require conjunction | ${s.catalystRequireConjunction ? 'yes' : 'no'} |`,
    );
    sections.push(`| Catalyst daily spend cap | ${fmtUsdMoney(s.catalystDailySpendCapUsd)} |`);
    sections.push(`| Exchanges enabled | ${s.exchangesEnabled.join(', ') || '(none)'} |`);
  }

  // Recent conversation — only render when there's prior history. The current
  // user message isn't included; that's guaranteed by `excludeMessagesAfter`
  // in the caller.
  if (unavailable.has('conversation')) {
    sections.push('', '## Recent conversation');
    sections.push('(prior conversation is unavailable for this response)');
  } else if (bundle.recentMessages.length > 0) {
    sections.push(
      '',
      `## Recent conversation (last ${bundle.recentMessages.length} turns, oldest → newest)`,
    );
    for (const m of bundle.recentMessages) {
      const truncated = m.content.length > 300 ? `${m.content.slice(0, 300)}…` : m.content;
      sections.push(`- ${m.role}: ${truncated}`);
    }
  }

  // ---- Discovery scores ---------------------------------------------------
  // One sub-section per ticker so each row of the breakdown is on its own
  // line. Joining components into one comma-string caused the model to skip
  // low-magnitude rows (insider negatives, near-zero filings, etc.).
  if (bundle.discoveryScores.length === 0) {
    sections.push('', '## Discovery scores (current batch)');
    sections.push(
      unavailable.has('discovery')
        ? '(discovery scores are unavailable for this response)'
        : '(no discovery scores for the relevant tickers)',
    );
  } else {
    for (const d of bundle.discoveryScores) {
      sections.push(
        '',
        `## Discovery score for ${d.ticker} — ${d.score.toFixed(2)} (computed ${ET_DATE(d.computedAt)})`,
      );
      const entries = orderBreakdown(d.breakdown);
      if (entries.length === 0) {
        sections.push('(no signal breakdown available)');
      } else {
        sections.push('| Component       | Score  | Reading |');
        sections.push('|-----------------|--------|---------|');
        for (const [k, v] of entries) {
          const name = k.padEnd(15, ' ');
          const score = v.toFixed(2).padStart(6, ' ');
          sections.push(`| ${name} | ${score} | ${readingFor(k, v)} |`);
        }
      }
    }
  }

  // ---- Current metrics ----------------------------------------------------
  sections.push('', '## Current metrics');
  if (bundle.metrics.length === 0) {
    sections.push(
      unavailable.has('metrics')
        ? '(current metrics are unavailable for this response)'
        : '(no metrics rows for the relevant tickers)',
    );
  } else {
    for (const m of bundle.metrics) {
      const x = m.metrics;
      const parts: string[] = [];
      if (x.peTtm !== null && x.peTtm !== undefined) parts.push(`P/E ${fmtNum(x.peTtm)}`);
      if (x.psTtm !== null && x.psTtm !== undefined) parts.push(`P/S ${fmtNum(x.psTtm)}`);
      if (x.pbTtm !== null && x.pbTtm !== undefined) parts.push(`P/B ${fmtNum(x.pbTtm)}`);
      if (x.evToEbitda !== null && x.evToEbitda !== undefined)
        parts.push(`EV/EBITDA ${fmtNum(x.evToEbitda)}`);
      if (x.roeTtm !== null && x.roeTtm !== undefined) parts.push(`ROE ${fmtPct(x.roeTtm)}`);
      if (x.roicTtm !== null && x.roicTtm !== undefined) parts.push(`ROIC ${fmtPct(x.roicTtm)}`);
      if (x.grossMarginTtm !== null && x.grossMarginTtm !== undefined)
        parts.push(`gross margin ${fmtPct(x.grossMarginTtm)}`);
      if (x.operatingMarginTtm !== null && x.operatingMarginTtm !== undefined)
        parts.push(`op margin ${fmtPct(x.operatingMarginTtm)}`);
      if (x.netMarginTtm !== null && x.netMarginTtm !== undefined)
        parts.push(`net margin ${fmtPct(x.netMarginTtm)}`);
      if (x.revenueGrowthYoy !== null && x.revenueGrowthYoy !== undefined)
        parts.push(`revenue YoY ${fmtPct(x.revenueGrowthYoy)}`);
      if (x.revenueGrowth5y !== null && x.revenueGrowth5y !== undefined)
        parts.push(`revenue 5y ${fmtPct(x.revenueGrowth5y)}`);
      if (x.epsGrowthYoy !== null && x.epsGrowthYoy !== undefined)
        parts.push(`EPS YoY ${fmtPct(x.epsGrowthYoy)}`);
      if (x.epsGrowth5y !== null && x.epsGrowth5y !== undefined)
        parts.push(`EPS 5y ${fmtPct(x.epsGrowth5y)}`);
      if (x.debtToEquity !== null && x.debtToEquity !== undefined)
        parts.push(`debt/equity ${fmtNum(x.debtToEquity)}`);
      if (x.beta !== null && x.beta !== undefined) parts.push(`beta ${fmtNum(x.beta)}`);
      if (x.marketCapUsd) parts.push(`market cap ${fmtMoneyShort(x.marketCapUsd)}`);
      if (x.avgDollarVolume30d !== null && x.avgDollarVolume30d !== undefined)
        parts.push(`avg $-vol ${fmtMoneyShort(x.avgDollarVolume30d)}`);
      sections.push(
        `- ${m.ticker}: ${parts.length > 0 ? parts.join(', ') : '(no metrics populated)'}`,
      );
    }
  }

  // ---- Fundamentals -------------------------------------------------------
  sections.push('', '## Last 4 quarters (revenue / net income / EPS)');
  if (bundle.fundamentals.length === 0) {
    sections.push(
      unavailable.has('fundamentals')
        ? '(fundamentals are unavailable for this response)'
        : '(no fundamentals snapshots for the relevant tickers)',
    );
  } else {
    for (const f of bundle.fundamentals) {
      sections.push('', `${f.ticker}:`);
      sections.push('| Period | Revenue | Net Inc | EPS (dil) |');
      sections.push('|--------|---------|---------|-----------|');
      for (const r of f.rows) {
        sections.push(
          `| ${ISO_DATE(r.periodEnd)} | ${fmtMoneyShort(r.revenue)} | ${fmtMoneyShort(r.netIncome)} | ${fmtDecimal(r.epsDiluted)} |`,
        );
      }
    }
  }

  // ---- Recent events ------------------------------------------------------
  // Unpack payload fields per kind so the model sees concrete names, dollar
  // amounts, and dates. Stringified JSON dumps got skipped over.
  sections.push('', '## Recent events (60d)');
  if (bundle.events.length === 0) {
    sections.push(
      unavailable.has('events')
        ? '(recent events are unavailable for this response)'
        : '(no MarketEvent rows for the relevant tickers in the last 60d)',
    );
  } else {
    for (const e of bundle.events) {
      sections.push('', `${e.ticker}:`);
      for (const ev of e.events) {
        for (const line of renderMarketEvent(ev)) {
          sections.push(`- ${line}`);
        }
      }
    }
  }

  // ---- Price action -------------------------------------------------------
  // Three trading-day windows (30d / 6mo / 1y) computed from DailyBar so chat
  // can answer time-bracketed questions. When the user quotes a diverging %
  // we flag it against the 30d value (the closest analog to the prior 20d
  // anchor) so the model doesn't echo a stale number.
  sections.push('', '## Price action');
  if (bundle.priceSummaries.length === 0) {
    sections.push(
      unavailable.has('prices')
        ? '(price history is unavailable for this response)'
        : '(no DailyBar history for the relevant tickers)',
    );
  } else {
    const quotedPcts = extractQuotedPercents(opts.userMessage ?? '');
    for (const p of bundle.priceSummaries) {
      sections.push('', `${p.ticker}:`);
      sections.push(`- 30d: ${formatWindowLine(p.r30, p.lastClose)}`);
      sections.push(`- 6mo: ${formatWindowLine(p.r6mo, p.lastClose)}`);
      sections.push(`- 1y: ${formatWindowLine(p.r1y, p.lastClose)}`);
      if (p.r30) {
        const mismatch = findMismatch(quotedPcts, p.r30.changePct);
        if (mismatch !== null) {
          sections.push(
            `- (User-quoted "${mismatch >= 0 ? '+' : ''}${mismatch}%" diverges ` +
              `from the 30d computed value — use this data as ground truth and ` +
              `note the discrepancy.)`,
          );
        }
      }
    }
  }

  // ---- Articles -----------------------------------------------------------
  sections.push('', '## Articles');
  if (bundle.articleHits.length === 0) {
    sections.push(
      unavailable.has('articles')
        ? '(article retrieval is unavailable for this response)'
        : '(no relevant articles indexed)',
    );
  } else {
    for (const h of bundle.articleHits) {
      sections.push(
        `- [src ${h.id}] ${h.headline} (${h.tickers.join(',') || '—'}, ${ET_DATE(h.publishedAt)})`,
      );
    }
  }

  // ---- Thesis evaluations -------------------------------------------------
  sections.push('', '## Thesis evaluations');
  if (bundle.thesisHits.length === 0) {
    sections.push(
      unavailable.has('thesisEvaluations')
        ? '(thesis-evaluation retrieval is unavailable for this response)'
        : '(no prior thesis evaluations indexed)',
    );
  } else {
    for (const h of bundle.thesisHits) {
      sections.push(`- [eval ${h.id}] ${h.newStatus}: ${h.rationale.slice(0, 220)}`);
    }
  }

  return sections.join('\n');
}

// ---------------------------------------------------------------------------
// Discovery breakdown rendering
// ---------------------------------------------------------------------------

// Canonical order — high-signal components first, so a model truncating from
// the bottom still keeps margins/valuation/growth. Unknown components fall
// through alphabetically at the end.
const BREAKDOWN_ORDER = [
  'margins',
  'profitability',
  'revenueGrowth',
  'epsGrowth',
  'valuation',
  'balanceSheet',
  'size',
  'liquidity',
  'momentum',
  'news',
  'sentiment',
  'filings',
  'earnings',
  'insider',
];

function orderBreakdown(b: Record<string, number>): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  const seen = new Set<string>();
  for (const k of BREAKDOWN_ORDER) {
    if (k in b) {
      out.push([k, b[k]!]);
      seen.add(k);
    }
  }
  for (const k of Object.keys(b).sort()) {
    if (!seen.has(k)) out.push([k, b[k]!]);
  }
  return out;
}

/**
 * Map a component score to a short qualitative reading. The tag varies by
 * component family because the same numeric value carries different meaning
 * (valuation=9 means "cheap", insider=9 means "strong buys").
 */
function readingFor(component: string, v: number): string {
  if (v < 0) {
    if (component === 'insider') return 'net selling / unfavorable';
    return 'unfavorable';
  }
  if (component === 'valuation') {
    if (v >= 9) return 'cheap';
    if (v >= 6) return 'fair';
    if (v >= 3) return 'expensive';
    return 'very expensive';
  }
  if (component === 'insider') {
    if (v >= 9) return 'strong cluster buying';
    if (v >= 6) return 'some buying';
    if (v >= 3) return 'minor buying';
    if (v > 0) return 'thin';
    return 'absent';
  }
  if (component === 'size') {
    if (v >= 9) return 'mid-large cap, supportive';
    if (v >= 6) return 'mid cap, supportive';
    if (v >= 3) return 'small cap';
    return 'micro cap';
  }
  if (component === 'liquidity') {
    if (v >= 9) return 'deep';
    if (v >= 5) return 'adequate';
    if (v >= 3) return 'thin';
    return 'illiquid';
  }
  if (component === 'momentum') {
    if (v >= 9) return 'strong uptrend';
    if (v >= 6) return 'positive';
    if (v >= 3) return 'mixed';
    if (v > 0) return 'weak';
    return 'flat';
  }
  if (component === 'sentiment') {
    if (v >= 9) return 'very positive';
    if (v >= 6) return 'positive';
    if (v >= 3) return 'mixed';
    if (v > 0) return 'cautious';
    return 'neutral';
  }
  if (component === 'news') {
    if (v >= 9) return 'heavy coverage';
    if (v >= 6) return 'active coverage';
    if (v >= 3) return 'some coverage';
    if (v > 0) return 'thin coverage';
    return 'no recent coverage';
  }
  if (component === 'filings') {
    if (v >= 9) return 'multiple material filings';
    if (v >= 6) return 'recent filings';
    if (v >= 3) return 'some filings';
    if (v > 0) return 'minimal recent filings';
    return 'no recent filings';
  }
  if (component === 'earnings') {
    if (v >= 9) return 'strong recent beat';
    if (v >= 6) return 'recent beat';
    if (v >= 3) return 'in-line';
    if (v > 0) return 'minor';
    return 'no recent surprise';
  }
  // Generic ladder for the remaining "higher-is-better" components
  // (margins, profitability, revenueGrowth, epsGrowth, balanceSheet).
  if (v >= 9) return 'best-in-class';
  if (v >= 6) return 'moderate';
  if (v >= 3) return 'weak';
  if (v > 0) return 'thin';
  return 'absent';
}

// ---------------------------------------------------------------------------
// Event payload rendering
// ---------------------------------------------------------------------------

interface PayloadObj {
  [key: string]: unknown;
}

function asObj(payload: unknown): PayloadObj | null {
  if (!payload || typeof payload !== 'object') return null;
  return payload as PayloadObj;
}

function asNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function asStr(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function fmtUsd(n: number): string {
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

/**
 * Render a MarketEvent as one or more bullet lines. Multi-line returns are
 * used by InsiderCluster (one row per insider) so each name + dollar amount
 * is unambiguously called out.
 */
export function renderMarketEvent(
  ev: Pick<MarketEvent, 'kind' | 'occurredAt' | 'payload'>,
): string[] {
  const date = ET_DATE(ev.occurredAt);
  const obj = asObj(ev.payload);

  switch (ev.kind) {
    case 'InsiderCluster': {
      if (!obj) return [`${date} Insider cluster — (no payload)`];
      const insiders = Array.isArray(obj['insiders']) ? (obj['insiders'] as unknown[]) : [];
      if (insiders.length === 0) {
        const total = asNum(obj['totalUsd']);
        return [`${date} Insider cluster buy — total ${total !== null ? fmtUsd(total) : '?'}`];
      }
      return insiders.map((i) => renderInsiderRow(date, asObj(i)));
    }
    case 'EarningsBeat':
    case 'Earnings': {
      if (!obj) return [`${date} ${ev.kind} — (no payload)`];
      const surprise = asNum(obj['surprise']);
      const actual = asNum(obj['actual']);
      const estimate = asNum(obj['estimate']);
      const revSurprise = asNum(obj['revenueSurprisePct']);
      const guidance = asStr(obj['guidanceDirection']);
      const parts: string[] = [];
      if (surprise !== null) {
        const sign = surprise >= 0 ? '+' : '';
        parts.push(`EPS surprise ${sign}${surprise.toFixed(1)}%`);
      }
      if (actual !== null && estimate !== null) {
        parts.push(`actual ${actual} vs estimate ${estimate}`);
      }
      if (revSurprise !== null) {
        const sign = revSurprise >= 0 ? '+' : '';
        parts.push(`revenue surprise ${sign}${revSurprise.toFixed(1)}%`);
      }
      if (guidance) parts.push(`guidance ${guidance}`);
      const label = ev.kind === 'EarningsBeat' ? 'Earnings beat' : 'Earnings';
      return [`${date} ${label}: ${parts.length > 0 ? parts.join(', ') : '(no detail)'}`];
    }
    case 'Material8K':
    case 'Filing8K': {
      if (!obj) return [`${date} ${ev.kind} — (no payload)`];
      const formType = asStr(obj['formType']) ?? '8-K';
      const items = asStr(obj['items']);
      const category = asStr(obj['category']);
      const summary = asStr(obj['summary']);
      const direction = asStr(obj['marketDirection']);
      const url = asStr(obj['filingUrl']) ?? asStr(obj['url']);
      const parts: string[] = [formType];
      if (items) parts.push(`items ${items}`);
      if (category) parts.push(category);
      if (direction) parts.push(`direction ${direction}`);
      if (summary) parts.push(summary.slice(0, 200));
      if (url) parts.push('[link]');
      const label = ev.kind === 'Material8K' ? 'Material 8-K filing' : '8-K filing';
      return [`${date} ${label}: ${parts.join(' — ')}`];
    }
    case 'AnalystUpgrade': {
      if (!obj) return [`${date} Analyst upgrade — (no payload)`];
      const from = asStr(obj['fromConsensus']);
      const to = asStr(obj['toConsensus']);
      const dStrong = asNum(obj['deltaStrongBuy']);
      const dBuy = asNum(obj['deltaBuy']);
      const parts: string[] = [];
      if (from && to) parts.push(`consensus ${from} → ${to}`);
      if (dStrong !== null) parts.push(`Δstrong-buy ${dStrong >= 0 ? '+' : ''}${dStrong}`);
      if (dBuy !== null) parts.push(`Δbuy ${dBuy >= 0 ? '+' : ''}${dBuy}`);
      return [`${date} Analyst upgrade: ${parts.length > 0 ? parts.join(', ') : '(no detail)'}`];
    }
    case 'IntradayMove': {
      if (!obj) return [`${date} Intraday move — (no payload)`];
      const pct = asNum(obj['pctChange']);
      const price = asNum(obj['price']);
      const open = asNum(obj['open']);
      const parts: string[] = [];
      if (pct !== null) {
        const sign = pct >= 0 ? '+' : '';
        parts.push(`${sign}${pct.toFixed(2)}%`);
      }
      if (price !== null) parts.push(`to $${price.toFixed(2)}`);
      if (open !== null) parts.push(`(open $${open.toFixed(2)})`);
      return [`${date} Intraday move: ${parts.join(' ')}`];
    }
    case 'Macro': {
      if (!obj) return [`${date} Macro — (no payload)`];
      const series = asStr(obj['seriesShortcut']) ?? asStr(obj['series']);
      const value = asNum(obj['value']);
      const prev = asNum(obj['previousValue']);
      const changePct = asNum(obj['changePct']);
      const parts: string[] = [];
      if (series) parts.push(series);
      if (value !== null) parts.push(`${value}`);
      if (prev !== null) parts.push(`(prev ${prev})`);
      if (changePct !== null) {
        const sign = changePct >= 0 ? '+' : '';
        parts.push(`Δ${sign}${changePct.toFixed(2)}%`);
      }
      return [`${date} Macro: ${parts.join(' ')}`];
    }
    default: {
      const json = obj ? JSON.stringify(obj).slice(0, 200) : '(no payload)';
      return [`${date} ${ev.kind} — ${json}`];
    }
  }
}

function renderInsiderRow(date: string, row: PayloadObj | null): string {
  if (!row) return `${date} Insider buy — (unparseable row)`;
  const name = asStr(row['insiderName']) ?? 'Unknown insider';
  const title = asStr(row['insiderTitle']);
  const shares = asNum(row['shares']);
  const price = asNum(row['pricePerShare']);
  const value = asNum(row['valueUsd']);
  const txnDate = asStr(row['transactionDate']);
  const dateStr = txnDate ? txnDate.slice(0, 10) : date;
  const sharesStr = shares !== null ? shares.toLocaleString('en-US') : '?';
  const priceStr = price !== null ? `$${price.toFixed(2)}` : '?';
  const valueStr = value !== null ? fmtUsd(value) : '?';
  const titleStr = title ? ` (${title})` : '';
  return `${dateStr} Insider buy: ${name}${titleStr} bought ${sharesStr} shares at ${priceStr} — ${valueStr} total`;
}

// ---------------------------------------------------------------------------
// Price-action helpers
// ---------------------------------------------------------------------------

/**
 * Render a single window row for the price-action block. Returns either a
 * "+X.X% ($a → $b)" fragment or "not enough data" so the row is preserved
 * even when DailyBar history is too short for the window.
 */
function formatWindowLine(w: PriceWindow | null, lastClose: number): string {
  if (!w) return 'not enough data';
  const sign = w.changePct >= 0 ? '+' : '';
  return (
    `${sign}${w.changePct.toFixed(1)}% ` +
    `($${w.startClose.toFixed(2)} → $${lastClose.toFixed(2)})`
  );
}

/**
 * Pull out every numeric % in the message. We look at a small window of
 * preceding words to infer sign: phrases like "down 1.17%" / "lost 1.17%" /
 * "fell 1.17%" yield -1.17, while "up 1.17%" / "gained 1.17%" yield +1.17.
 * A bare "1.17%" stays positive. We also keep an explicit leading sign.
 */
function extractQuotedPercents(message: string): number[] {
  const out: number[] = [];
  const re = /([+-]?)(\d+(?:\.\d+)?)\s*%/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(message)) !== null) {
    const sign = m[1]!;
    let n = Number(m[2]);
    if (!Number.isFinite(n)) continue;
    if (sign === '-') n = -n;
    else if (sign === '+') {
      // already positive
    } else {
      // Look back up to 25 chars for a directional keyword.
      const start = Math.max(0, m.index - 25);
      const prefix = message.slice(start, m.index).toLowerCase();
      if (
        /\b(down|lost|fell|fall|drop|dropped|declined|decline|lower|negative|off|losing)\b\s*$/.test(
          prefix,
        )
      ) {
        n = -n;
      }
    }
    out.push(n);
  }
  return out;
}

/**
 * If any quoted % in the user's message diverges from `computed` by more than
 * 0.3 absolute percentage points, return the first such number so the
 * formatter can call out the discrepancy. Returns null otherwise (no quote,
 * or every quote roughly matches).
 */
function findMismatch(quoted: number[], computed: number): number | null {
  if (quoted.length === 0) return null;
  for (const q of quoted) {
    if (Math.abs(q - computed) > 0.3) return q;
  }
  return null;
}
