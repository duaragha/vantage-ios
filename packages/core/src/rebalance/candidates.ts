/**
 * Candidate sourcer for the rebalance engine.
 *
 * Surfaces tickers worth considering for a cap-corrective or opportunistic
 * rotation/buy. Three buckets:
 *   (a) Held tickers below target weight (room to add)
 *   (b) Watchlist tickers with strong recent catalysts (Articles in last 14d
 *       + MarketEvents)
 *   (c) News-surfaced unheld tickers — top 5 most-mentioned across the last
 *       30d of Articles (keyword filter already applied at ingestion time
 *       so we can trust `Article.tickers` as "passed keyword filter").
 *
 * Every candidate is filtered against active `PassCooldown` rows for the
 * `'buy'` actionKind BEFORE leaving this module — so token budget is never
 * spent on suggestions that downstream filters would reject anyway.
 *
 * Score heuristic (higher = more attractive):
 *   recency     : 1 / days_since_most_recent_mention (capped at 1.0)
 *   eventBoost  : +0.5 per MarketEvent in window
 *   tierBoost   : +1.0 for each tier-1 mention, +0.5 for tier-2, 0 for tier-3
 *   bucketBoost : held-below-weight +1.0, watchlist-catalyst +0.5, else 0
 *
 * The engine uses the score as a tiebreaker when deciding what to include
 * in the prompt (we cap total candidates to keep tokens sane).
 */

import {
  prisma,
  isPassCooldownActive,
  latestTopN,
  type Article,
  type MarketEvent,
  type Position,
  type UserSettings,
  type Watchlist,
} from '@vantage/db';

import type { ConcentrationResult, ConcentrationViolation } from './metrics.js';
import { getUsdCadRate } from '../fx.js';
import { auditPortfolio } from '../portfolio/valuation.js';

export type CandidateReason =
  | 'held-below-weight'
  | 'watchlist-catalyst'
  | 'news-surfaced'
  | 'discovery-surfaced'
  | 'violation-target';

export interface Candidate {
  ticker: string;
  reason: CandidateReason;
  /** Aggregate priority score (see heuristic in module docs). */
  score: number;
  /** Number of qualifying Articles observed in the lookback window. */
  mentions: number;
  /** Number of qualifying MarketEvents observed in the lookback window. */
  eventCount: number;
  /** Best article tier observed (1 is best). undefined if no mentions. */
  bestTier?: number;
  /** Held-position sector (when bucket (a) applies) or null. */
  sector: string | null;
  /** True when the ticker is currently held. */
  isHeld: boolean;
  /** True when the ticker is on the watchlist. */
  isOnWatchlist: boolean;
}

export type CandidateKind = 'monthly-allocation' | 'rebalance-suggest';

export interface SourceCandidatesOptions {
  kind: CandidateKind;
  /** Open positions snapshot. */
  positions?: ReadonlyArray<Position>;
  /** Watchlist rows snapshot. */
  watchlist?: ReadonlyArray<Watchlist>;
  /** User settings (singlePositionCapPct used to compute "below weight" threshold). */
  settings?: Pick<UserSettings, 'singlePositionCapPct'>;
  /** Optional concentration snapshot — avoids recomputing when the engine already has one. */
  concentration?: ConcentrationResult;
  /** Cap violations — used to tag the offending tickers with reason='violation-target'. */
  violations?: ReadonlyArray<ConcentrationViolation>;
  /** Max candidates returned. Defaults to 12. */
  maxCandidates?: number;
  /**
   * When true, skip PassCooldown filtering (useful for ops/testing). Default false.
   */
  skipCooldownFilter?: boolean;
  logger?: {
    info?: (obj: unknown, msg?: string) => void;
    warn?: (obj: unknown, msg?: string) => void;
  };
}

const NEWS_LOOKBACK_DAYS = 30;
const WATCHLIST_LOOKBACK_DAYS = 14;

/**
 * Main entry. Returns ordered, filtered, scored candidates.
 */
export async function sourceCandidates(opts: SourceCandidatesOptions): Promise<Candidate[]> {
  const maxCandidates = opts.maxCandidates ?? 12;
  const skipCooldown = opts.skipCooldownFilter === true;

  // Load snapshot data if caller didn't provide it.
  const [positions, watchlist, settings] = await Promise.all([
    opts.positions
      ? Promise.resolve(opts.positions)
      : prisma.position.findMany({ where: { closedAt: null } }),
    opts.watchlist ? Promise.resolve(opts.watchlist) : prisma.watchlist.findMany(),
    opts.settings
      ? Promise.resolve(opts.settings)
      : prisma.userSettings.findUnique({ where: { id: 1 } }),
  ]);
  if (!settings) {
    throw new Error('[rebalance/candidates] UserSettings not found (id=1)');
  }

  const heldTickers = new Set(positions.map((p) => p.ticker.toUpperCase()));
  const watchlistTickers = new Set(watchlist.map((w) => w.ticker.toUpperCase()));
  const violationTickers = new Set(
    (opts.violations ?? [])
      .filter((v): v is ConcentrationViolation & { ticker: string } => Boolean(v.ticker))
      .map((v) => v.ticker.toUpperCase()),
  );

  const now = new Date();
  const newsSince = new Date(now.getTime() - NEWS_LOOKBACK_DAYS * 24 * 3600_000);
  const watchSince = new Date(now.getTime() - WATCHLIST_LOOKBACK_DAYS * 24 * 3600_000);

  // Pull 30d of articles once and slice below. Cap at 2000 rows — the
  // monthly digest uses the same ceiling and it's been safe there.
  const [articles30d, events30d] = await Promise.all([
    prisma.article.findMany({
      where: {
        publishedAt: { gte: newsSince },
        satireBlocked: false,
      },
      select: {
        id: true,
        tickers: true,
        sourceTier: true,
        publishedAt: true,
      },
      take: 2000,
      orderBy: { publishedAt: 'desc' },
    }) as Promise<Array<Pick<Article, 'id' | 'tickers' | 'sourceTier' | 'publishedAt'>>>,
    prisma.marketEvent.findMany({
      where: {
        occurredAt: { gte: newsSince },
        NOT: { ticker: null },
      },
      select: { id: true, ticker: true, occurredAt: true, kind: true },
      take: 500,
      orderBy: { occurredAt: 'desc' },
    }) as Promise<Array<Pick<MarketEvent, 'id' | 'ticker' | 'occurredAt' | 'kind'>>>,
  ]);

  // Index article mentions per ticker with recency/tier signals.
  const articleIndex = buildTickerIndex(articles30d, now);
  const watchArticleIndex = buildTickerIndex(
    articles30d.filter((a) => a.publishedAt >= watchSince),
    now,
  );
  const eventIndex = buildEventIndex(events30d);

  const candidates = new Map<string, Candidate>();

  // ---- (a) held tickers below target weight -----------------------------
  const halfCap = settings.singlePositionCapPct / 2;
  const positionPctMap = new Map<string, number>();
  if (opts.concentration) {
    for (const pp of opts.concentration.positionPcts) {
      positionPctMap.set(pp.ticker.toUpperCase(), pp.pct);
    }
  } else {
    // Fall back to an FX-normalized cost-basis weight.
    const audit = auditPortfolio({
      positions,
      usdCadRate: await getUsdCadRate(),
    });
    for (const [ticker, value] of audit.byTicker) {
      positionPctMap.set(ticker, value.pct);
    }
  }

  for (const p of positions) {
    const key = p.ticker.toUpperCase();
    const pct = positionPctMap.get(key) ?? 0;
    if (pct >= halfCap) continue;
    const idx = articleIndex.get(key);
    const ev = eventIndex.get(key);
    candidates.set(
      key,
      scoreCandidate({
        ticker: key,
        reason: 'held-below-weight',
        sector: p.sector,
        isHeld: true,
        isOnWatchlist: watchlistTickers.has(key),
        articleSignal: idx,
        eventSignal: ev,
        bucketBoost: 1.0,
      }),
    );
  }

  // ---- (b) watchlist tickers with recent catalysts ----------------------
  for (const w of watchlist) {
    const key = w.ticker.toUpperCase();
    if (candidates.has(key)) continue;
    const idx = watchArticleIndex.get(key);
    const ev = eventIndex.get(key);
    const hasCatalyst = (idx?.mentions ?? 0) > 0 || (ev?.count ?? 0) > 0;
    if (!hasCatalyst) continue;
    candidates.set(
      key,
      scoreCandidate({
        ticker: key,
        reason: 'watchlist-catalyst',
        sector: null,
        isHeld: false,
        isOnWatchlist: true,
        articleSignal: idx,
        eventSignal: ev,
        bucketBoost: 0.5,
      }),
    );
  }

  // ---- (c) news-surfaced unheld tickers ---------------------------------
  const newsSurfaced: Candidate[] = [];
  for (const [ticker, idx] of articleIndex) {
    if (heldTickers.has(ticker)) continue;
    if (watchlistTickers.has(ticker)) continue;
    if (candidates.has(ticker)) continue;
    const ev = eventIndex.get(ticker);
    newsSurfaced.push(
      scoreCandidate({
        ticker,
        reason: 'news-surfaced',
        sector: null,
        isHeld: false,
        isOnWatchlist: false,
        articleSignal: idx,
        eventSignal: ev,
        bucketBoost: 0,
      }),
    );
  }
  newsSurfaced.sort((a, b) => b.score - a.score);
  for (const c of newsSurfaced.slice(0, 5)) candidates.set(c.ticker, c);

  // ---- (d) Phase 15 — discovery-surfaced unheld tickers ------------------
  // The rebalance engine can now benefit from the nightly discovery signal
  // (not just monthly). Only applies to 'rebalance-suggest' — the
  // monthly-allocation path has its own DiscoveryScore pull.
  if (opts.kind === 'rebalance-suggest') {
    try {
      const top = await latestTopN(10, {
        excludeTickers: [...heldTickers, ...watchlistTickers],
        minScore: 0,
      });
      for (const d of top) {
        const ticker = d.ticker.toUpperCase();
        if (candidates.has(ticker)) continue;
        const idx = articleIndex.get(ticker);
        const ev = eventIndex.get(ticker);
        // Blend discovery score into the bucket boost so a strong score
        // surfaces even when article mentions are sparse.
        const discoveryBoost = Math.max(0, d.score);
        candidates.set(
          ticker,
          scoreCandidate({
            ticker,
            reason: 'discovery-surfaced',
            sector: null,
            isHeld: false,
            isOnWatchlist: false,
            articleSignal: idx,
            eventSignal: ev,
            bucketBoost: discoveryBoost,
          }),
        );
      }
    } catch (err) {
      opts.logger?.warn?.(
        { err: err instanceof Error ? err.message : err },
        '[rebalance/candidates] DiscoveryScore lookup failed — continuing',
      );
    }
  }

  // ---- Tag violation-target tickers --------------------------------------
  // When a single-position cap is breached we want to present the offender
  // to the model explicitly — not as a buy candidate, but as a trim target.
  // Override the reason so the engine's prompt can separate trim vs buy.
  for (const offender of violationTickers) {
    const existing = candidates.get(offender);
    if (existing) {
      existing.reason = 'violation-target';
    } else {
      // Synthesize a minimal candidate so the prompt mentions the offender.
      const pos = positions.find((p) => p.ticker.toUpperCase() === offender);
      const idx = articleIndex.get(offender);
      const ev = eventIndex.get(offender);
      candidates.set(
        offender,
        scoreCandidate({
          ticker: offender,
          reason: 'violation-target',
          sector: pos?.sector ?? null,
          isHeld: heldTickers.has(offender),
          isOnWatchlist: watchlistTickers.has(offender),
          articleSignal: idx,
          eventSignal: ev,
          bucketBoost: 0,
        }),
      );
    }
  }

  // ---- PassCooldown filter (BUY action) ---------------------------------
  // Violation-targets skip the cooldown check — a trim on a held cap-breacher
  // is an action the user has NOT passed on (passCooldown keys off action
  // kind, and we're not suggesting a "buy" for them).
  const filtered: Candidate[] = [];
  for (const c of candidates.values()) {
    if (skipCooldown || c.reason === 'violation-target') {
      filtered.push(c);
      continue;
    }
    const blocked = await isPassCooldownActive(c.ticker, 'buy');
    if (blocked) {
      opts.logger?.info?.(
        { ticker: c.ticker, reason: c.reason },
        '[rebalance/candidates] filtered — active buy cooldown',
      );
      continue;
    }
    filtered.push(c);
  }

  // Sort by: violation-targets first (must be in prompt), then by score.
  filtered.sort((a, b) => {
    const aIsViolation = a.reason === 'violation-target' ? 1 : 0;
    const bIsViolation = b.reason === 'violation-target' ? 1 : 0;
    if (aIsViolation !== bIsViolation) return bIsViolation - aIsViolation;
    return b.score - a.score;
  });

  const result = filtered.slice(0, maxCandidates);
  opts.logger?.info?.(
    {
      kind: opts.kind,
      positions: positions.length,
      watchlist: watchlist.length,
      violations: violationTickers.size,
      considered: candidates.size,
      filtered: result.length,
    },
    '[rebalance/candidates] sourced',
  );
  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TickerArticleSignal {
  mentions: number;
  /** Most recent publish time. */
  mostRecent: Date;
  /** Best (lowest) source tier observed. */
  bestTier: number;
  /** Count per tier — [0]=tier-1, [1]=tier-2, [2]=tier-3. */
  tierCounts: [number, number, number];
}

interface TickerEventSignal {
  count: number;
  mostRecent: Date;
}

function buildTickerIndex(
  articles: ReadonlyArray<Pick<Article, 'tickers' | 'sourceTier' | 'publishedAt'>>,
  _now: Date,
): Map<string, TickerArticleSignal> {
  const out = new Map<string, TickerArticleSignal>();
  for (const a of articles) {
    for (const rawTicker of a.tickers) {
      const t = rawTicker.toUpperCase();
      const prev = out.get(t);
      const tier = clampTier(a.sourceTier);
      if (!prev) {
        const tierCounts: [number, number, number] = [0, 0, 0];
        tierCounts[tier - 1] = 1;
        out.set(t, {
          mentions: 1,
          mostRecent: a.publishedAt,
          bestTier: tier,
          tierCounts,
        });
      } else {
        prev.mentions += 1;
        if (a.publishedAt > prev.mostRecent) prev.mostRecent = a.publishedAt;
        if (tier < prev.bestTier) prev.bestTier = tier;
        const idx = (tier - 1) as 0 | 1 | 2;
        prev.tierCounts[idx] = (prev.tierCounts[idx] ?? 0) + 1;
      }
    }
  }
  return out;
}

function buildEventIndex(
  events: ReadonlyArray<Pick<MarketEvent, 'ticker' | 'occurredAt'>>,
): Map<string, TickerEventSignal> {
  const out = new Map<string, TickerEventSignal>();
  for (const e of events) {
    if (!e.ticker) continue;
    const t = e.ticker.toUpperCase();
    const prev = out.get(t);
    if (!prev) {
      out.set(t, { count: 1, mostRecent: e.occurredAt });
    } else {
      prev.count += 1;
      if (e.occurredAt > prev.mostRecent) prev.mostRecent = e.occurredAt;
    }
  }
  return out;
}

function clampTier(t: number | undefined | null): 1 | 2 | 3 {
  if (t === 1) return 1;
  if (t === 3) return 3;
  return 2;
}

interface ScoreInput {
  ticker: string;
  reason: CandidateReason;
  sector: string | null;
  isHeld: boolean;
  isOnWatchlist: boolean;
  articleSignal: TickerArticleSignal | undefined;
  eventSignal: TickerEventSignal | undefined;
  bucketBoost: number;
}

function scoreCandidate(input: ScoreInput): Candidate {
  const nowMs = Date.now();
  let recency = 0;
  let tierBoost = 0;
  let mentions = 0;
  let bestTier: number | undefined;
  if (input.articleSignal) {
    mentions = input.articleSignal.mentions;
    bestTier = input.articleSignal.bestTier;
    const daysSince = Math.max(
      1,
      (nowMs - input.articleSignal.mostRecent.getTime()) / (24 * 3600_000),
    );
    recency = Math.min(1, 1 / daysSince);
    const [t1, t2] = input.articleSignal.tierCounts;
    tierBoost = t1 * 1.0 + t2 * 0.5;
  }
  const eventCount = input.eventSignal?.count ?? 0;
  const eventBoost = eventCount * 0.5;
  const score = recency + tierBoost + eventBoost + input.bucketBoost;
  const candidate: Candidate = {
    ticker: input.ticker,
    reason: input.reason,
    score,
    mentions,
    eventCount,
    sector: input.sector,
    isHeld: input.isHeld,
    isOnWatchlist: input.isOnWatchlist,
  };
  if (bestTier !== undefined) candidate.bestTier = bestTier;
  return candidate;
}
