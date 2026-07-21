/**
 * Goal loader helpers — pulls non-archived goals from the DB and matches a
 * ticker against the goals whose recommended-security profile fits.
 *
 * Used by the catalyst engine: when a BUY suggestion lands, we ask "does this
 * ticker also push the user toward one of their stated goals?" If yes, the
 * footer adds a 🎯 line so the alert connects to the broader plan rather than
 * floating as just another trade.
 *
 * Curated securities must appear by exact ticker in the goal's recommendation
 * slate. Off-curated securities must first clear the same discovery, strategy,
 * income-risk, and account filters as the goal detail page, then also appear by
 * exact ticker. A broad category match is not enough: one individual stock
 * cannot inherit another individual stock's goal fit.
 */

import { prisma, type Prisma, type AccountType, type GoalStrategy } from '@vantage/db';
import {
  deriveRiskTolerance,
  recommendAccount,
  recommendSecurities,
  type SecurityRecommendation,
  type GoalInput,
  type GoalType,
  type RiskTolerance,
} from './engine.js';
import { loadAccountSummaries } from '../accounts/loaders.js';
import {
  CURATED_POOL,
  findCurated,
  incomeRiskFloorForSecurity,
  isYieldTrap,
} from './securityPool.js';
import {
  GOAL_INCOME_RISK_KEYS,
  INCOME_RISK_PROFILES,
  MONTHLY_INCOME_TICKERS,
  incomeRiskAllows,
  monthlyIncomeFallback,
} from './monthlyIncome.js';
import { percentagePointsToRatio } from '../units.js';

export interface DiscoveryPick {
  ticker: string;
  name: string | null;
  score: number;
  currency: 'CAD' | 'USD';
  listingCountry: 'US' | 'CA';
  hasDividend: boolean;
  isUsDivPayer: boolean;
  marketCapUsd: number | null;
  sector: string | null;
  isLottery: boolean;
  /** Positive annual yield as a decimal ratio when this pick was classified as income. */
  incomeYield?: number | null;
  /** Provider metrics win; the reviewed monthly-income registry is the fallback. */
  incomeYieldSource?: 'metrics' | 'curated' | null;
  /** TickerUniverse.category when known — used as a yield-independent signal so
   * a covered-call / dividend name with a null dividendYieldTtm still gets
   * classified correctly by the strategy filter. Optional so test fixtures and
   * older callers don't have to supply it. */
  category?: string | null;
}

// Yield-bearing categories: a Growth goal must NOT surface these (they cap
// upside / chase income), and an Income goal prefers them — even when the
// TickerMetrics dividend yield is null.
const YIELD_CATEGORIES = new Set([
  'DividendCanadian',
  'DividendUS',
  'CoveredCall',
  'REIT',
  'IntermediateBond',
  'ShortTermBond',
]);

// Exchange → listing country buckets. Anything not listed defaults to US so we
// don't accidentally treat unknown exchanges as Canadian for tax purposes.
const US_EXCHANGES = new Set(['NYSE', 'NASDAQ', 'NYSE ARCA', 'AMEX', 'BATS']);
const CA_EXCHANGES = new Set(['TO', 'TSX', 'NE', 'V', 'TSXV', 'CSE', 'NEO']);

function listingCountryOf(exchange: string | null | undefined): 'US' | 'CA' {
  if (!exchange) return 'US';
  const up = exchange.toUpperCase();
  if (CA_EXCHANGES.has(up)) return 'CA';
  if (US_EXCHANGES.has(up)) return 'US';
  return 'US';
}

const RRSP_FAMILY: ReadonlySet<AccountType> = new Set<AccountType>([
  'RRSP',
  'SpousalRRSP',
  'LIRA',
  'RRIF',
]);

/** Latest positive TTM yield per ticker, normalized from percentage points to a ratio. */
export async function loadIncomeYieldOverrides(
  tickers: readonly string[],
): Promise<Record<string, number>> {
  const upper = Array.from(new Set(tickers.map((ticker) => ticker.toUpperCase())));
  if (upper.length === 0) return {};

  const rows = await prisma.tickerMetrics.findMany({
    where: { ticker: { in: upper } },
    select: { ticker: true, dividendYieldTtm: true },
  });
  const out: Record<string, number> = {};
  for (const row of rows) {
    const ratio = percentagePointsToRatio(row.dividendYieldTtm);
    if (ratio !== null && ratio > 0) out[row.ticker.toUpperCase()] = ratio;
  }
  return out;
}

/** Latest raw discovery composite per ticker, keyed by uppercase symbol. */
export async function loadLatestDiscoveryScoresByTicker(
  tickers: readonly string[],
): Promise<Record<string, number>> {
  const upper = Array.from(new Set(tickers.map((ticker) => ticker.toUpperCase())));
  if (upper.length === 0) return {};

  const rows = await prisma.discoveryScore.findMany({
    where: { ticker: { in: upper } },
    orderBy: { computedAt: 'desc' },
    select: { ticker: true, score: true },
  });
  const out: Record<string, number> = {};
  for (const row of rows) {
    const ticker = row.ticker.toUpperCase();
    if (!(ticker in out)) out[ticker] = row.score;
  }
  return out;
}

// NAV-erosion guard thresholds. A high distribution yield paired with a sharply
// negative 1y price return is the signature of a return-of-capital yield trap
// (the YieldMax pattern: pay a fat distribution while the NAV bleeds). This
// catches future YieldMax-clones that aren't on the manual blocklist yet.
const EROSION_YIELD_FLOOR = 0.08;
const EROSION_RETURN_CEILING = -0.15;
/**
 * Trailing-1y price return for a ticker from its DailyBar history. Pulls the
 * oldest + newest bar inside the last 365d and returns (newest-oldest)/oldest.
 *
 * Returns null when there's insufficient history (fewer than 2 distinct bars in
 * the window) — callers give the ticker the benefit of the doubt (don't exclude)
 * but also don't boost it.
 */
async function oneYearPriceReturn(ticker: string, now: Date = new Date()): Promise<number | null> {
  const since = new Date(now.getTime() - 365 * 24 * 3600 * 1000);
  const [oldest, newest] = await Promise.all([
    prisma.dailyBar.findFirst({
      where: { ticker: ticker.toUpperCase(), date: { gte: since } },
      orderBy: { date: 'asc' },
      select: { close: true, date: true },
    }),
    prisma.dailyBar.findFirst({
      where: { ticker: ticker.toUpperCase(), date: { gte: since } },
      orderBy: { date: 'desc' },
      select: { close: true, date: true },
    }),
  ]);
  if (!oldest || !newest) return null;
  if (oldest.date.getTime() === newest.date.getTime()) return null; // single bar
  const start = Number(oldest.close);
  const end = Number(newest.close);
  if (!Number.isFinite(start) || start <= 0 || !Number.isFinite(end)) return null;
  return end / start - 1;
}

/**
 * Pull top-N individual-ticker discovery picks, optionally filtered by
 * account-tax-fitness so the mix into goal recommendations stays principled.
 *
 * Filters per accountType:
 *   - TFSA / RESP: prefer no/low div, growth-y (penalize US div payers)
 *   - RRSP / SpousalRRSP / LIRA / RRIF: prefer US div payers + REITs
 *   - Personal / Margin / Corporate: prefer Cdn-listed div payers / Cdn small-cap
 *
 * Filters always applied:
 *   - score > 0
 *   - TickerUniverse.isLottery = false (lottery names skipped — they belong in
 *     speculative-account-only flows, not goal-driven recommendations)
 *   - Latest DiscoveryScore batch only (current snapshot)
 *   - Excludes any ticker passed in `excludeTickers` (caller dedupes against
 *     curated pool to avoid duplicates)
 */
export async function loadTopDiscoveryPicks(opts: {
  limit?: number;
  excludeTickers?: string[];
  accountType?: AccountType;
  /**
   * Goal strategy. Filters the candidate set BEFORE the account-tax tilt:
   *   Income       → only dividend-payers (an income goal must produce cash flow)
   *   Growth       → only non-dividend names (growth shape)
   *   Preservation → no discovery picks at all (cash/bonds only)
   *   Balanced/unset → no strategy filter; account tilt alone
   */
  strategy?: 'Income' | 'Growth' | 'Balanced' | 'Preservation' | null;
  /** Derived goal risk, used to keep income discovery picks on the same yield floor as /discovery. */
  risk?: RiskTolerance;
}): Promise<DiscoveryPick[]> {
  const limit = opts.limit ?? 8;
  const exclude = new Set((opts.excludeTickers ?? []).map((t) => t.toUpperCase()));

  // Preservation goals never hold individual equity discovery picks.
  if (opts.strategy === 'Preservation') return [];

  // Step 1 — anchor on the latest batch so we don't pollute the result with
  // stale ticker scores from earlier nightly runs.
  const latest = await prisma.discoveryScore.aggregate({
    _max: { computedAt: true },
  });
  const computedAt = latest._max.computedAt;
  if (!computedAt) return [];

  // Step 2 — pull a generous slice; we'll filter and re-sort in JS so the
  // account-tax fallback logic works against the same candidate set.
  const scores = await prisma.discoveryScore.findMany({
    where: { computedAt, score: { gt: 0 } },
    orderBy: { score: 'desc' },
    take: 1000,
    select: { ticker: true, score: true },
  });
  if (scores.length === 0) return [];

  const tickers = scores.map((s) => s.ticker.toUpperCase());

  // Step 3 — pull universe + metrics in parallel, then join in-memory.
  const [universeRows, metricsRows] = await Promise.all([
    prisma.tickerUniverse.findMany({
      where: { symbol: { in: tickers } },
      select: {
        symbol: true,
        name: true,
        exchange: true,
        currency: true,
        sector: true,
        marketCapUsd: true,
        category: true,
        isLottery: true,
      },
    }),
    prisma.tickerMetrics.findMany({
      where: { ticker: { in: tickers } },
      select: { ticker: true, dividendYieldTtm: true },
    }),
  ]);
  const universeBySymbol = new Map(universeRows.map((u) => [u.symbol.toUpperCase(), u]));
  const yieldByTicker = new Map(
    metricsRows.map((m) => [m.ticker.toUpperCase(), percentagePointsToRatio(m.dividendYieldTtm)]),
  );

  // Step 4 — build the full enriched candidate list (filter lottery + excluded).
  // Track each pick's TTM dividend yield so the NAV-erosion guard (step 4c) can
  // pair a high distribution with a sharp price drop.
  const enriched: DiscoveryPick[] = [];
  const yieldOfPick = new Map<string, number | null>();
  for (const s of scores) {
    const t = s.ticker.toUpperCase();
    if (exclude.has(t)) continue;
    // Layer 2 — hard blocklist. YieldMax + single-stock synthetic covered-call
    // ETFs are NAV-erosion yield traps; never surface them from discovery.
    if (isYieldTrap(t)) continue;
    const u = universeBySymbol.get(t);
    if (!u) continue;
    if (u.isLottery) continue;
    const liveYield = yieldByTicker.get(t) ?? null;
    const fallbackYield = monthlyIncomeFallback(t)?.expectedYield ?? null;
    const hasLiveYield = liveYield !== null && liveYield > 0;
    const dy = hasLiveYield ? liveYield : fallbackYield;
    const incomeYieldSource = hasLiveYield ? 'metrics' : fallbackYield !== null ? 'curated' : null;
    yieldOfPick.set(t, dy);
    const hasDividend = (dy ?? 0) > 0.005;
    const listingCountry = listingCountryOf(u.exchange);
    enriched.push({
      ticker: t,
      name: u.name ?? null,
      score: s.score,
      currency: u.currency === 'CAD' ? 'CAD' : 'USD',
      listingCountry,
      hasDividend,
      isUsDivPayer: hasDividend && listingCountry === 'US',
      marketCapUsd: u.marketCapUsd ? Number(u.marketCapUsd) : null,
      sector: u.sector,
      isLottery: u.isLottery,
      incomeYield: dy,
      incomeYieldSource,
      category: u.category ?? null,
    });
  }
  if (enriched.length === 0) return [];

  // Step 4b — strategy filter. An Income goal must only surface dividend-payers
  // (a no-div growth name makes zero sense as an income pick); a Growth goal
  // wants the opposite. Applied before the account tilt. If the strategy filter
  // empties the set, we keep it empty — better to show only curated dividend
  // ETFs than to recommend a non-dividend stock for an income goal.
  // Yield-or-category test: treat a pick as income-flavoured if it pays a
  // dividend OR its category is yield-bearing (covered-call/REIT/dividend/bond).
  // This is null-safe — a covered-call ETF with a missing dividendYieldTtm is
  // still correctly classified as income, not growth.
  const isIncomeFlavoured = (p: DiscoveryPick): boolean =>
    p.hasDividend || (p.category != null && YIELD_CATEGORIES.has(p.category));
  let strategyFiltered = enriched;
  if (opts.strategy === 'Income') {
    const selectedRisk = opts.risk ? GOAL_INCOME_RISK_KEYS[opts.risk] : null;
    const minYield = selectedRisk ? INCOME_RISK_PROFILES[selectedRisk].minYield : 0.005;
    strategyFiltered = enriched.filter((pick) => {
      const ticker = pick.ticker.toUpperCase();
      if (
        !MONTHLY_INCOME_TICKERS.has(ticker) ||
        !isIncomeFlavoured(pick) ||
        (yieldOfPick.get(ticker) ?? 0) < minYield
      ) {
        return false;
      }
      if (!selectedRisk) return true;
      const curated = findCurated(ticker);
      const riskFloor = curated
        ? incomeRiskFloorForSecurity(curated)
        : (monthlyIncomeFallback(ticker)?.riskFloor ?? 'aggressive');
      return incomeRiskAllows(selectedRisk, riskFloor);
    });
  } else if (opts.strategy === 'Growth') {
    strategyFiltered = enriched.filter((p) => !isIncomeFlavoured(p));
  }
  if (strategyFiltered.length === 0) return [];

  // Step 4c — Layer 3 algorithmic NAV-erosion guard. For high-distribution
  // candidates (yield > 8%), check the 1y price trajectory: if the price has
  // fallen > 15% while still paying a fat distribution, it's almost certainly
  // funding payouts via return-of-capital (the YieldMax signature) → exclude.
  // This catches future YieldMax-clones not on the manual blocklist. Tickers
  // with insufficient price history get the benefit of the doubt (kept).
  const highYield = strategyFiltered.filter(
    (p) => (yieldOfPick.get(p.ticker.toUpperCase()) ?? 0) > EROSION_YIELD_FLOOR,
  );
  if (highYield.length > 0) {
    const returns = await Promise.all(highYield.map((p) => oneYearPriceReturn(p.ticker)));
    const eroding = new Set<string>();
    highYield.forEach((p, i) => {
      const r = returns[i];
      if (r != null && r < EROSION_RETURN_CEILING) eroding.add(p.ticker.toUpperCase());
    });
    if (eroding.size > 0) {
      strategyFiltered = strategyFiltered.filter((p) => !eroding.has(p.ticker.toUpperCase()));
    }
  }
  if (strategyFiltered.length === 0) return [];

  // Step 5 — account-tax fitness filter. Each branch keeps an ordered list
  // (already score-desc) and falls back to the broader candidate set when
  // its filtered slice can't fill `limit` — better to recommend a slightly
  // off-account growth name than show nothing for High/Aggressive goals.
  const acct = opts.accountType;
  let filtered: DiscoveryPick[];
  if (acct === 'TFSA' || acct === 'RESP') {
    // Cap-gains-shaped goal — strip US div payers (15% withholding leak).
    filtered = strategyFiltered.filter((p) => !p.isUsDivPayer);
  } else if (acct && RRSP_FAMILY.has(acct)) {
    // Treaty-exempt US div / REIT zone. REITs almost never make it into the
    // discovery universe (REITs trade in Cdn-listed form, scored separately),
    // so the second predicate is mostly defensive.
    const preferred = strategyFiltered.filter(
      (p) => p.isUsDivPayer || (p as { sector?: string | null }).sector === 'Real Estate',
    );
    if (preferred.length >= limit) {
      filtered = preferred;
    } else {
      // Fall back to all non-Canadian-div picks (Cdn div champions get the DTC
      // hit when held in RRSP, so we'd rather pad with US-listed names).
      const padding = strategyFiltered.filter(
        (p) => !preferred.includes(p) && !(p.hasDividend && p.listingCountry === 'CA'),
      );
      filtered = [...preferred, ...padding];
    }
  } else if (acct === 'Personal' || acct === 'Margin' || acct === 'Corporate') {
    // Non-reg — favour Cdn-listed (eligible dividend tax credit + no FTC paperwork).
    const cdn = strategyFiltered.filter((p) => p.listingCountry === 'CA');
    if (cdn.length >= limit) {
      filtered = cdn;
    } else {
      // Pad with no-div US names (cap-gains shape works OK in non-reg if TFSA is maxed).
      const padding = strategyFiltered.filter((p) => !cdn.includes(p) && !p.isUsDivPayer);
      filtered = [...cdn, ...padding];
    }
  } else {
    filtered = strategyFiltered;
  }

  return filtered.slice(0, limit);
}

export interface GoalMatch {
  goalId: number;
  goalName: string;
  goalType: string;
  /** 0..100 — how well this ticker matches the goal's recommended profile. */
  fitScore: number;
  /** One-sentence WHY — pulled from the matching recommendation. */
  reason: string;
}

/** Exact-ticker match used by the catalyst footer. Category equality is deliberately insufficient. */
export function bestRecommendationForTicker(
  recommendations: readonly SecurityRecommendation[],
  ticker: string,
): SecurityRecommendation | null {
  const upper = ticker.toUpperCase();
  let best: SecurityRecommendation | null = null;
  for (const recommendation of recommendations) {
    if (recommendation.security.ticker.toUpperCase() !== upper) continue;
    if (!best || recommendation.fitScore > best.fitScore) best = recommendation;
  }
  return best;
}

interface GoalRowForMatching {
  id: number;
  name: string;
  type: GoalType;
  targetAmountCad: Prisma.Decimal;
  targetDate: Date | null;
  isWithdrawal: boolean;
  riskOverride: RiskTolerance | null;
  strategy: GoalStrategy | null;
  accountId: number | null;
  account: { type: AccountType } | null;
}

function toGoalInput(row: GoalRowForMatching): GoalInput {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    targetAmountCad: Number(row.targetAmountCad),
    targetDate: row.targetDate,
    isWithdrawal: row.isWithdrawal,
    riskOverride: row.riskOverride,
    strategy: row.strategy,
    accountId: row.accountId,
  };
}

/**
 * Given a ticker, return the active goals where this ticker fits the
 * recommended-security profile. Empty array when no category is resolvable
 * or when no goal's profile includes the category.
 *
 * Goals are returned sorted by `fitScore` descending so callers can take the
 * top N.
 */
export async function findFittingGoals(ticker: string): Promise<GoalMatch[]> {
  const targetTicker = ticker.toUpperCase();
  const goals = (await prisma.goal.findMany({
    where: { archivedAt: null },
    select: {
      id: true,
      name: true,
      type: true,
      targetAmountCad: true,
      targetDate: true,
      isWithdrawal: true,
      riskOverride: true,
      strategy: true,
      accountId: true,
      account: { select: { type: true } },
    },
  })) as unknown as GoalRowForMatching[];

  if (goals.length === 0) return [];

  const curatedTickers = CURATED_POOL.map((security) => security.ticker);
  const [discoveryScoreByTicker, incomeYieldByTicker, accounts] = await Promise.all([
    loadLatestDiscoveryScoresByTicker([...curatedTickers, targetTicker]),
    loadIncomeYieldOverrides([...curatedTickers, targetTicker]),
    loadAccountSummaries(),
  ]);
  const targetCurated = findCurated(targetTicker);
  const discoveryPickCache = new Map<string, Promise<DiscoveryPick | null>>();
  const matches: GoalMatch[] = [];
  for (const row of goals) {
    const goalInput = toGoalInput(row);
    const recommendedAccount = recommendAccount(goalInput, accounts);
    const effectiveAccountType =
      row.account?.type ?? (recommendedAccount.rankedTypes[0] as AccountType | undefined);
    let targetDiscoveryPick: DiscoveryPick | null = null;
    if (!targetCurated) {
      const risk = deriveRiskTolerance(goalInput);
      if (risk !== 'High' && risk !== 'Aggressive') continue;
      const cacheKey = [risk, row.strategy ?? '', effectiveAccountType ?? ''].join(':');
      let pending = discoveryPickCache.get(cacheKey);
      if (!pending) {
        pending = loadTopDiscoveryPicks({
          limit: 1000,
          excludeTickers: curatedTickers,
          risk,
          ...(effectiveAccountType ? { accountType: effectiveAccountType } : {}),
          ...(row.strategy ? { strategy: row.strategy } : {}),
        }).then(
          (picks) => picks.find((pick) => pick.ticker.toUpperCase() === targetTicker) ?? null,
        );
        discoveryPickCache.set(cacheKey, pending);
      }
      targetDiscoveryPick = await pending;
      if (!targetDiscoveryPick) continue;
    }

    // Pull the full curated recommendation list so an exact valid ticker is
    // not dropped merely because it ranked below the dashboard's visible cap.
    // For a discovery ticker, pass only that already-filtered target so the
    // engine can score it without another ticker taking its satellite slot.
    const recs = recommendSecurities(goalInput, {
      limit: 100,
      ...(effectiveAccountType ? { goalAccountType: effectiveAccountType } : {}),
      ...(targetDiscoveryPick ? { discoveryPicks: [targetDiscoveryPick] } : {}),
      ...(Object.keys(discoveryScoreByTicker).length > 0 ? { discoveryScoreByTicker } : {}),
      ...(Object.keys(incomeYieldByTicker).length > 0 ? { incomeYieldByTicker } : {}),
    });
    const best = bestRecommendationForTicker(recs, targetTicker);
    if (!best) continue;
    matches.push({
      goalId: row.id,
      goalName: row.name,
      goalType: row.type,
      fitScore: best.fitScore,
      reason: best.reason,
    });
  }

  matches.sort((a, b) => b.fitScore - a.fitScore);
  return matches;
}
