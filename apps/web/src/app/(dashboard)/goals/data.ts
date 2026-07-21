// /goals — server-side data loader.
//
// Pulls Goal rows with linked positions + account, then runs the goals engine
// (packages/core/src/goals/engine.ts) over them to derive progress + account
// recommendation + security recommendation. The dashboard consumes this
// pre-computed shape so the UI stays presentational.

import {
  prisma,
  getLatestBarsForTickers,
  type AccountType,
  type ContributionFrequency,
  type GoalStrategy,
  type SecurityCategory,
  type TradingStyle,
} from '@vantage/db';
import { getUsdCadRate } from '@vantage/core/fx';
import {
  CURATED_POOL,
  computeProgress,
  deriveRiskTolerance,
  detectConflicts,
  findCurated,
  recommendAccount,
  recommendSecurities,
  riskHorizonOverrideWarning,
  scanDayTradeCandidates,
  glideAllocation,
  loadIncomeYieldOverrides,
  loadLatestDiscoveryScoresByTicker,
  loadTopDiscoveryPicks,
  projectGoal,
  type DayTradeCandidate,
  type DcaProjection,
  type GoalConflict,
  type GoalInput,
  type GoalProgress,
  type LinkedPosition,
  type GoalType,
  type RiskTolerance,
} from '@vantage/core/goals';
import type { Prisma } from '@prisma/client';
import { loadAccountSummaries } from '@vantage/core/accounts';

export interface GoalListItem {
  id: number;
  name: string;
  type: GoalType;
  targetAmountCad: number;
  targetDate: Date | null;
  isWithdrawal: boolean;
  notes: string | null;
  riskOverride: RiskTolerance | null;
  strategy: GoalStrategy | null;
  tradingStyle: TradingStyle | null;
  /** DCA contribution schedule (funding method). Null when no plan is set. */
  contributionAmountCad: number | null;
  contributionFrequency: ContributionFrequency | null;
  contributionStartDate: Date | null;
  account: { id: number; name: string; type: string } | null;
  archivedAt: Date | null;
  linkedPositionCount: number;
  progress: GoalProgress;
}

export interface LinkedPositionRow {
  positionId: number;
  ticker: string;
  accountId: number;
  accountName: string;
  shares: number;
  avgCost: number;
  latestClose: number | null;
  valueCad: number;
  allocation: number;
}

export interface GoalDetail extends GoalListItem {
  positions: LinkedPositionRow[];
  recommendedSecurities: Array<{
    ticker: string;
    name: string;
    currency: 'CAD' | 'USD';
    reason: string;
    fitScore: number;
    description: string;
    /** True when the security is optimal for the goal's effective account type (Canadian tax math). */
    optimalForAccount: boolean;
    /** Per-account tax rationale picked out for the goal's account, when present. */
    taxRationale?: string;
    /** 'curated' for the curated ETF pool; 'discovery' for individual-ticker picks mixed in from the discovery scan. */
    kind: 'curated' | 'discovery';
    /** Underlying composite discovery score — only present when kind === 'discovery'. */
    discoveryScore?: number;
    /** Yield used by the recommendation engine, shown with its provenance. */
    incomeYield?: number;
    incomeYieldSource?: 'metrics' | 'curated';
    /** NAV-erosion / sustainability risk for high-distribution products. Drives
     * the amber warning pill on the goal detail page. null/undefined = N/A. */
    navErosionRisk?: 'low' | 'moderate' | 'high' | null;
  }>;
  /** Effective account type used for the tax-aware recommendation pass (the goal's account, or the top-ranked recommended type). */
  recommendedFor: AccountType | null;
  recommendedAccount: {
    rankedTypes: string[];
    bestAccountId: number | null;
    bestAccountName: string | null;
    rationale: string;
    contributionRoomCad: number | null;
    warning?: string;
  };
  glide: { cashPct: number; bondPct: number; equityPct: number };
  /** Honest warning when an explicit risk override is being honored over the
   * horizon de-risking on a near-dated goal. Null when no override mismatch. */
  riskHorizonWarning: string | null;
  /** Nightly GoalSnapshot history (last ~180 days, ascending) for the progress-over-time chart. */
  snapshots: Array<{ date: Date; valueCad: number }>;
  /** Actual cash/bond/equity mix of the goal's linked positions, by CAD weight. Null when nothing is linked. */
  actualAllocation: { cashPct: number; bondPct: number; equityPct: number } | null;
  /** Day-trade candidate watchlist — only populated when type === 'DayTrading'. */
  dayTradeCandidates: DayTradeCandidate[];
  /** Forward DCA projection from the contribution schedule. hasSchedule=false when no plan set. Always null for DayTrading. */
  projection: DcaProjection;
  /** Per-period contribution split across the goal's top recommended securities by target weight. Empty when no schedule or no recs. */
  contributionSplit: Array<{
    ticker: string;
    name: string;
    currency: 'CAD' | 'USD';
    weight: number;
    amountCad: number;
  }>;
}

interface GoalRowFromDb {
  id: number;
  name: string;
  type: GoalType;
  targetAmountCad: Prisma.Decimal;
  targetDate: Date | null;
  isWithdrawal: boolean;
  notes: string | null;
  riskOverride: RiskTolerance | null;
  strategy: GoalStrategy | null;
  tradingStyle: TradingStyle | null;
  contributionAmountCad: Prisma.Decimal | null;
  contributionFrequency: ContributionFrequency | null;
  contributionStartDate: Date | null;
  accountId: number | null;
  archivedAt: Date | null;
  createdAt: Date;
  account: { id: number; name: string; type: string } | null;
  contributions: Array<{
    allocation: Prisma.Decimal;
    position: {
      id: number;
      ticker: string;
      shares: Prisma.Decimal;
      avgCost: Prisma.Decimal;
      currency: string;
      accountId: number;
      account: { id: number; name: string; type: string };
    };
  }>;
}

function toGoalInput(row: GoalRowFromDb): GoalInput {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    targetAmountCad: Number(row.targetAmountCad),
    targetDate: row.targetDate,
    isWithdrawal: row.isWithdrawal,
    riskOverride: row.riskOverride,
    strategy: row.strategy,
    tradingStyle: row.tradingStyle,
    accountId: row.accountId,
    createdAt: row.createdAt,
    archivedAt: row.archivedAt,
  };
}

function toLinkedPositions(
  row: GoalRowFromDb,
  latestCloses: Map<string, number>,
): LinkedPosition[] {
  return row.contributions.map((c) => {
    const upper = c.position.ticker.toUpperCase();
    // Fall back to avgCost when there's no market price yet (freshly-added
    // ticker the pollers haven't fetched), so a real holding shows its cost
    // basis instead of $0.
    const close = latestCloses.get(upper) ?? Number(c.position.avgCost);
    // Use the POSITION's own currency (VDY.TO=CAD, AAPL=USD), not the account's.
    const posCurrency = c.position.currency === 'USD' ? 'USD' : 'CAD';
    return {
      positionId: c.position.id,
      ticker: upper,
      shares: Number(c.position.shares),
      latestClose: close,
      currency: posCurrency,
      allocation: Number(c.allocation),
      accountId: c.position.accountId,
      listingCountry: posCurrency === 'USD' ? 'US' : 'CA',
      accountType: c.position.account.type,
    };
  });
}

type AllocationBucket = 'cash' | 'bond' | 'equity' | null;

// Collapse a SecurityCategory into the three glide-path buckets so an actual
// holding mix can be compared to the target bar. Anything unclassifiable (Other,
// or a ticker outside both the curated pool and TickerUniverse) returns null and
// is dropped from the weighting rather than skewing a bucket.
function categoryToBucket(category: SecurityCategory): AllocationBucket {
  switch (category) {
    case 'CashEquivalent':
      return 'cash';
    case 'ShortTermBond':
    case 'IntermediateBond':
      return 'bond';
    case 'DividendCanadian':
    case 'DividendUS':
    case 'EquityCanadian':
    case 'EquityUS':
    case 'EquityInternational':
    case 'EquityEmerging':
    case 'AllEquity':
    case 'Growth':
    case 'REIT':
    case 'Speculative':
    case 'LeveragedETF':
    case 'SectorEquity':
    case 'IndividualStock':
    case 'CryptoAdjacent':
    case 'CoveredCall':
      return 'equity';
    case 'Balanced':
      // A balanced fund is roughly 60/40; split it so it doesn't masquerade as pure equity.
      return null;
    case 'Other':
    default:
      return null;
  }
}

// Resolve a ticker's SecurityCategory the same way loaders.ts does: curated pool
// first, then TickerUniverse. Curated lookups are synchronous; only fall back to
// the DB for off-curated tickers.
async function resolveTickerCategory(ticker: string): Promise<SecurityCategory | null> {
  const upper = ticker.toUpperCase();
  const curated = findCurated(upper);
  if (curated) return curated.category;
  const row = await prisma.tickerUniverse.findUnique({
    where: { symbol: upper },
    select: { category: true },
  });
  return row?.category ?? null;
}

// Bucket each linked position's CAD value into cash/bond/equity by resolved
// category, returning percentages. Balanced funds are split 60% equity / 40%
// bond. Null when no linked value resolves to a bucket.
async function computeActualAllocation(
  positions: LinkedPositionRow[],
): Promise<{ cashPct: number; bondPct: number; equityPct: number } | null> {
  if (positions.length === 0) return null;
  let cash = 0;
  let bond = 0;
  let equity = 0;
  let classified = 0;
  for (const p of positions) {
    const category = await resolveTickerCategory(p.ticker);
    if (category === null) continue;
    const value = p.valueCad;
    if (value <= 0) continue;
    if (category === 'Balanced') {
      equity += value * 0.6;
      bond += value * 0.4;
      classified += value;
      continue;
    }
    const bucket = categoryToBucket(category);
    if (bucket === null) continue;
    if (bucket === 'cash') cash += value;
    else if (bucket === 'bond') bond += value;
    else equity += value;
    classified += value;
  }
  if (classified <= 0) return null;
  return {
    cashPct: Math.round((cash / classified) * 100),
    bondPct: Math.round((bond / classified) * 100),
    equityPct: Math.round((equity / classified) * 100),
  };
}

async function valuateGoals(rows: GoalRowFromDb[]): Promise<GoalListItem[]> {
  const allTickers = Array.from(
    new Set(rows.flatMap((g) => g.contributions.map((c) => c.position.ticker.toUpperCase()))),
  );
  const bars = await getLatestBarsForTickers(allTickers);
  const latest = new Map<string, number>();
  for (const [ticker, bar] of bars) latest.set(ticker, Number(bar.close));
  const usdToCad = await getUsdCadRate();

  return rows.map((g) => {
    const goalInput = toGoalInput(g);
    const linked = toLinkedPositions(g, latest);
    const progress = computeProgress(goalInput, linked, usdToCad);

    return {
      id: g.id,
      name: g.name,
      type: g.type,
      targetAmountCad: Number(g.targetAmountCad),
      targetDate: g.targetDate,
      isWithdrawal: g.isWithdrawal,
      notes: g.notes,
      riskOverride: g.riskOverride,
      strategy: g.strategy,
      tradingStyle: g.tradingStyle,
      contributionAmountCad:
        g.contributionAmountCad == null ? null : Number(g.contributionAmountCad),
      contributionFrequency: g.contributionFrequency,
      contributionStartDate: g.contributionStartDate,
      account: g.account,
      archivedAt: g.archivedAt,
      linkedPositionCount: g.contributions.length,
      progress,
    };
  });
}

export async function listGoals(opts?: { includeArchived?: boolean }): Promise<GoalListItem[]> {
  const where = opts?.includeArchived ? {} : { archivedAt: null };
  const rows = (await prisma.goal.findMany({
    where,
    include: {
      account: { select: { id: true, name: true, type: true } },
      contributions: {
        include: {
          position: {
            include: {
              account: { select: { id: true, name: true, type: true, currency: true } },
            },
          },
        },
      },
    },
    orderBy: [{ archivedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'desc' }],
  })) as unknown as GoalRowFromDb[];

  return valuateGoals(rows);
}

export async function getGoal(id: number): Promise<GoalListItem | null> {
  const row = (await prisma.goal.findUnique({
    where: { id },
    include: {
      account: { select: { id: true, name: true, type: true } },
      contributions: {
        include: {
          position: {
            include: {
              account: { select: { id: true, name: true, type: true, currency: true } },
            },
          },
        },
      },
    },
  })) as unknown as GoalRowFromDb | null;
  if (!row) return null;
  const [item] = await valuateGoals([row]);
  return item ?? null;
}

export async function getGoalDetail(id: number): Promise<GoalDetail | null> {
  const row = (await prisma.goal.findUnique({
    where: { id },
    include: {
      account: { select: { id: true, name: true, type: true } },
      contributions: {
        include: {
          position: {
            include: {
              account: { select: { id: true, name: true, type: true, currency: true } },
            },
          },
        },
      },
    },
  })) as unknown as GoalRowFromDb | null;
  if (!row) return null;

  const allTickers = row.contributions.map((c) => c.position.ticker.toUpperCase());
  const bars = await getLatestBarsForTickers(allTickers);
  const latest = new Map<string, number>();
  for (const [ticker, bar] of bars) latest.set(ticker, Number(bar.close));
  const usdToCad = await getUsdCadRate();

  const goalInput = toGoalInput(row);
  const linked = toLinkedPositions(row, latest);
  const progress = computeProgress(goalInput, linked, usdToCad);

  const positions: LinkedPositionRow[] = linked.map((p) => {
    const native = (p.latestClose ?? 0) * p.shares * p.allocation;
    const cad = p.currency === 'USD' ? native * usdToCad : native;
    const dbContribution = row.contributions.find((c) => c.position.id === p.positionId);
    const avgCost = dbContribution ? Number(dbContribution.position.avgCost) : 0;
    return {
      positionId: p.positionId,
      ticker: p.ticker,
      accountId: p.accountId,
      accountName: dbContribution?.position.account.name ?? '',
      shares: p.shares,
      avgCost,
      latestClose: p.latestClose,
      valueCad: Math.round(cad * 100) / 100,
      allocation: p.allocation,
    };
  });

  const accountSummaries = await loadAccountSummaries();
  const recAccount = recommendAccount(goalInput, accountSummaries);
  // AccountSummary carries no name, so resolve the real account name for the
  // recommended account (e.g. "My RRSP") rather than synthesising "Account #12".
  const bestAccount = recAccount.bestAccountId
    ? await prisma.account.findUnique({
        where: { id: recAccount.bestAccountId },
        select: { id: true, name: true, type: true },
      })
    : null;
  const recommendedAccountSummary = bestAccount
    ? accountSummaries.find((a) => a.id === bestAccount.id)
    : null;
  // Effective account-type for the tax-aware security pass.
  //   1. If the goal is linked to a specific account → use that account's type.
  //   2. Otherwise → use the top-ranked recommended type from recommendAccount.
  // Cast through unknown because the upstream account.type is the raw string
  // off the Prisma row; we know it's one of the AccountType enum values.
  const linkedAccountType: AccountType | null = row.account
    ? (row.account.type as unknown as AccountType)
    : null;
  const fallbackAccountType: AccountType | null = recAccount.rankedTypes[0]
    ? (recAccount.rankedTypes[0] as unknown as AccountType)
    : null;
  const effectiveAccountType: AccountType | null = linkedAccountType ?? fallbackAccountType;

  // DayTrading is a fundamentally different surface: candidates come from the
  // day-trade scanner (daily-bar derived), NOT the curated buy-and-hold pool or
  // the discovery scan. Skip both for this goal type.
  const isDayTrading = row.type === 'DayTrading';
  const dayTradeCandidates: DayTradeCandidate[] = isDayTrading
    ? await scanDayTradeCandidates({
        ...(row.tradingStyle ? { style: row.tradingStyle } : {}),
        limit: 15,
        // The goal's target amount IS the trading capital — drives the 1%-risk
        // per-candidate position size in each trade plan.
        capital: Number(row.targetAmountCad),
        usdToCad,
      })
    : [];

  // Discovery picks only enrich High/Aggressive buy-and-hold goals. Skip the DB
  // hit for lower risk tiers (and entirely for DayTrading) so the page-load cost
  // stays unchanged for capital-preservation goals.
  const risk = deriveRiskTolerance(goalInput);
  const wantsDiscovery = !isDayTrading && (risk === 'High' || risk === 'Aggressive');
  const discoveryPicks = wantsDiscovery
    ? await loadTopDiscoveryPicks({
        limit: 8,
        excludeTickers: CURATED_POOL.map((c) => c.ticker),
        risk,
        ...(effectiveAccountType ? { accountType: effectiveAccountType } : {}),
        ...(goalInput.strategy ? { strategy: goalInput.strategy } : {}),
      })
    : [];

  // Expand the limit when discovery picks are in play so the satellite sleeve
  // actually surfaces past the broad-equity ETF leaders (which top out in the
  // high-90s and tiebreak by curated insertion order). For lower-risk goals
  // the original 5-row cap stays in place. DayTrading returns [] from the engine.
  const recLimit = wantsDiscovery ? 10 : 5;

  // Latest DiscoveryScore per curated ticker — folded continuously into the
  // curated fit so individual-stock picks (NVDA/TSLA/...) get a discovery nudge.
  // Most curated ETFs have no row (the scanner biases to US large-caps), so this
  // is additive signal on top of MER/yield. Skipped for DayTrading (no curated
  // recs). The engine stays pure; the DB query lives here.
  const [discoveryScoreByTicker, incomeYieldByTicker] = isDayTrading
    ? [{}, {}]
    : await Promise.all([
        loadLatestDiscoveryScoresByTicker(CURATED_POOL.map((security) => security.ticker)),
        loadIncomeYieldOverrides(CURATED_POOL.map((security) => security.ticker)),
      ]);

  const recSecurities = recommendSecurities(goalInput, {
    limit: recLimit,
    ...(effectiveAccountType ? { goalAccountType: effectiveAccountType } : {}),
    ...(discoveryPicks.length > 0 ? { discoveryPicks } : {}),
    ...(Object.keys(discoveryScoreByTicker).length > 0 ? { discoveryScoreByTicker } : {}),
    ...(Object.keys(incomeYieldByTicker).length > 0 ? { incomeYieldByTicker } : {}),
  });

  // Nightly GoalSnapshot trend — last ~180 days ascending, for the
  // progress-over-time chart. Empty (or single-point) when the snapshot job
  // hasn't run enough times yet; the chart renders an empty-state in that case.
  const since = new Date(Date.now() - 180 * 24 * 3600 * 1000);
  const snapshotRows = await prisma.goalSnapshot.findMany({
    where: { goalId: row.id, date: { gte: since } },
    select: { date: true, valueCad: true },
    orderBy: { date: 'asc' },
  });
  const snapshots = snapshotRows.map((s) => ({
    date: s.date,
    valueCad: Number(s.valueCad),
  }));

  const actualAllocation = await computeActualAllocation(positions);

  const glide = glideAllocation(goalInput);

  // Honest risk-vs-horizon warning when an explicit override is being honored
  // over the horizon de-risking (e.g. Aggressive on a 12-month DownPayment).
  const riskHorizonWarning = riskHorizonOverrideWarning(goalInput)?.message ?? null;

  // Forward DCA projection. DayTrading never has a contribution schedule (it's a
  // buy-and-hold funding method), so feed nulls there — projectGoal returns a
  // quiet no-schedule shape. The rate is priced off the goal's glide split so a
  // near-dated goal projects at the cash-weighted rate it's actually told to
  // hold, not its raw risk tier (risk/strategy stay as the no-glide fallback).
  const projection = projectGoal({
    currentValue: progress.currentValueCad,
    contributionAmountCad: isDayTrading
      ? null
      : row.contributionAmountCad == null
        ? null
        : Number(row.contributionAmountCad),
    frequency: isDayTrading ? null : row.contributionFrequency,
    startDate: isDayTrading ? null : row.contributionStartDate,
    targetDate: row.targetDate,
    targetAmountCad: Number(row.targetAmountCad),
    risk: row.riskOverride,
    strategy: row.strategy,
    glide,
    asOf: new Date(),
  });

  // Contribution split — divide the per-period amount across the top recommended
  // securities by their fitScore as a proxy weight (the same recs the page
  // already shows). Curated ETF leaders saturate at fit=100; weighting by
  // fitScore keeps the split aligned with what we surface, and never appears for
  // DayTrading (no recs) or when there's no schedule.
  const contributionSplit: GoalDetail['contributionSplit'] = [];
  if (projection.hasSchedule && row.contributionAmountCad != null && recSecurities.length > 0) {
    const amount = Number(row.contributionAmountCad);
    const splitPicks = recSecurities.slice(0, 3);
    const totalFit = splitPicks.reduce((s, r) => s + Math.max(0, r.fitScore), 0);
    if (totalFit > 0) {
      let allocated = 0;
      splitPicks.forEach((r, i) => {
        const weight = Math.max(0, r.fitScore) / totalFit;
        // Last row absorbs the rounding remainder so the split always sums to the
        // exact per-period amount.
        const amountCad =
          i === splitPicks.length - 1
            ? Math.round((amount - allocated) * 100) / 100
            : Math.round(amount * weight * 100) / 100;
        allocated += amountCad;
        contributionSplit.push({
          ticker: r.security.ticker,
          name: r.security.name,
          currency: r.security.currency,
          weight,
          amountCad,
        });
      });
    }
  }

  return {
    id: row.id,
    name: row.name,
    type: row.type,
    targetAmountCad: Number(row.targetAmountCad),
    targetDate: row.targetDate,
    isWithdrawal: row.isWithdrawal,
    notes: row.notes,
    riskOverride: row.riskOverride,
    strategy: row.strategy,
    tradingStyle: row.tradingStyle,
    contributionAmountCad:
      row.contributionAmountCad == null ? null : Number(row.contributionAmountCad),
    contributionFrequency: row.contributionFrequency,
    contributionStartDate: row.contributionStartDate,
    account: row.account,
    archivedAt: row.archivedAt,
    linkedPositionCount: row.contributions.length,
    progress,
    positions,
    recommendedSecurities: recSecurities.map((s) => ({
      ticker: s.security.ticker,
      name: s.security.name,
      currency: s.security.currency,
      reason: s.reason,
      fitScore: s.fitScore,
      description: s.security.description,
      optimalForAccount: s.optimalForAccount,
      kind: s.kind,
      ...(s.taxRationale ? { taxRationale: s.taxRationale } : {}),
      ...(s.discoveryScore !== undefined ? { discoveryScore: s.discoveryScore } : {}),
      ...(s.incomeYield !== undefined ? { incomeYield: s.incomeYield } : {}),
      ...(s.incomeYieldSource ? { incomeYieldSource: s.incomeYieldSource } : {}),
      ...(s.security.navErosionRisk != null ? { navErosionRisk: s.security.navErosionRisk } : {}),
    })),
    recommendedFor: effectiveAccountType,
    recommendedAccount: {
      rankedTypes: recAccount.rankedTypes,
      bestAccountId: recAccount.bestAccountId,
      bestAccountName: bestAccount ? bestAccount.name : null,
      rationale: recAccount.rationale,
      contributionRoomCad: recommendedAccountSummary?.contributionRoomCad ?? null,
      ...(recAccount.warning ? { warning: recAccount.warning } : {}),
    },
    glide,
    riskHorizonWarning,
    snapshots,
    actualAllocation,
    dayTradeCandidates,
    projection,
    contributionSplit,
  };
}

// Load all non-archived goals + their linked positions + accounts and run the
// engine's cross-goal conflict detector. Surfaced as a banner on /goals. Each
// LinkedPosition carries its owning goalId so allocation-overflow can attribute
// the colliding goals.
export async function loadGoalConflicts(): Promise<{
  conflicts: GoalConflict[];
  goalNames: Map<number, string>;
}> {
  const rows = (await prisma.goal.findMany({
    where: { archivedAt: null },
    include: {
      account: { select: { id: true, name: true, type: true } },
      contributions: {
        include: {
          position: {
            include: {
              account: { select: { id: true, name: true, type: true, currency: true } },
            },
          },
        },
      },
    },
  })) as unknown as GoalRowFromDb[];

  if (rows.length === 0) return { conflicts: [], goalNames: new Map() };

  const allTickers = Array.from(
    new Set(rows.flatMap((g) => g.contributions.map((c) => c.position.ticker.toUpperCase()))),
  );
  const bars = await getLatestBarsForTickers(allTickers);
  const latest = new Map<string, number>();
  for (const [ticker, bar] of bars) latest.set(ticker, Number(bar.close));
  const usdToCad = await getUsdCadRate();

  // Compute each goal's current value in CAD so room-shortfall conflicts use
  // remaining funding need, not the raw target.
  const goalInputs = rows.map((row) => {
    const linked = toLinkedPositions(row, latest);
    const goalInput = toGoalInput(row);
    const progress = computeProgress(goalInput, linked, usdToCad);
    return { ...goalInput, currentValueCad: progress.currentValueCad };
  });

  // Tag each link with its owning goalId so detectConflicts can attribute
  // allocation-overflow back to the sharing goals.
  const positions: LinkedPosition[] = rows.flatMap((row) =>
    toLinkedPositions(row, latest).map((p) => ({ ...p, goalId: row.id })),
  );
  const accountSummaries = await loadAccountSummaries();

  const conflicts = detectConflicts(goalInputs, positions, accountSummaries);
  const goalNames = new Map(rows.map((g) => [g.id, g.name]));
  return { conflicts, goalNames };
}
