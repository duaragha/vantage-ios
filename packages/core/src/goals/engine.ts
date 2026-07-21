// Goals decision engine. Pure functions over GoalInput + accounts + positions;
// no DB calls. Mirrors the shape and style of accounts/placement.ts.

import type { AccountType } from '@vantage/db';
import type { AccountSummary } from '../accounts/placement.js';
import { decidePlacement } from '../accounts/placement.js';
import {
  type CuratedSecurity,
  findCurated,
  incomeRiskFloorForSecurity,
  isYieldTrap,
  poolByCategories,
} from './securityPool.js';
import {
  GOAL_INCOME_RISK_KEYS,
  INCOME_RISK_PROFILES,
  MONTHLY_INCOME_TICKERS,
  incomeRiskAllows,
  monthlyIncomeFallback,
} from './monthlyIncome.js';
import type { DiscoveryPick } from './loaders.js';
import { discoveryScoreToRotationSignal } from '../discover/signals.js';

// Hoisted above SecurityRecommendation so the interface can reference it. Kept
// as a local string union rather than re-importing the Prisma enum to avoid
// dragging @vantage/db into otherwise-pure engine code.
type SecurityCategoryLocal =
  | 'CashEquivalent'
  | 'ShortTermBond'
  | 'IntermediateBond'
  | 'DividendCanadian'
  | 'DividendUS'
  | 'EquityCanadian'
  | 'EquityUS'
  | 'EquityInternational'
  | 'EquityEmerging'
  | 'AllEquity'
  | 'Balanced'
  | 'Growth'
  | 'REIT'
  | 'Speculative'
  | 'Other'
  | 'LeveragedETF'
  | 'SectorEquity'
  | 'IndividualStock'
  | 'CryptoAdjacent'
  | 'CoveredCall';

export type GoalType =
  | 'Withdrawal'
  | 'DownPayment'
  | 'Vacation'
  | 'TaxBill'
  | 'EmergencyFund'
  | 'Income'
  | 'Retirement'
  | 'Education'
  | 'Custom'
  | 'DayTrading';

// Mirrors the Prisma TradingStyle enum. Kept as a local string union so the
// engine stays free of @vantage/db imports (same pattern as SecurityCategoryLocal).
export type TradingStyle = 'Momentum' | 'Breakout' | 'ORB' | 'MeanReversion' | 'Scalping';

export type RiskTolerance = 'VeryLow' | 'Low' | 'Moderate' | 'High' | 'Aggressive';

// Primary-purpose axis orthogonal to GoalType + RiskTolerance. Strategy only
// narrows the candidate category list — it never overrides the tax-fitness
// logic in recommendAccount / optimalForAccount / taxRationale.
export type GoalStrategy = 'Income' | 'Growth' | 'Balanced' | 'Preservation';

export interface GoalInput {
  id: number;
  name: string;
  type: GoalType;
  targetAmountCad: number;
  targetDate: Date | null;
  isWithdrawal: boolean;
  riskOverride: RiskTolerance | null;
  /** Optional purpose axis (Income/Growth/Balanced/Preservation). Null = engine picks by type. */
  strategy?: GoalStrategy | null;
  /** Day-trading style — only meaningful when type === 'DayTrading'. Null otherwise. */
  tradingStyle?: TradingStyle | null;
  accountId: number | null;
  /**
   * When the goal was created — the start of its glide window. Used by
   * computeProgress to derive expected linear progress (elapsed/total) for the
   * on-track signal. Optional with a `now` fallback so non-progress callers
   * (recommendation/conflict paths) needn't supply it, but data loaders driving
   * the on-track badge MUST pass the real Goal.createdAt.
   */
  createdAt?: Date;
  /**
   * Current linked value, in CAD. Used by conflict detection to compare required
   * contribution-room capacity against remaining shortfall rather than the full
   * target.
   */
  currentValueCad?: number;
  /**
   * Optional archive flag on DB-backed goal rows; used by detectConflicts so
   * loaders can skip dead goals cleanly without a local structural copy.
   */
  archivedAt?: Date | null;
}

export interface LinkedPosition {
  positionId: number;
  ticker: string;
  shares: number;
  latestClose: number | null;
  currency: 'USD' | 'CAD';
  listingCountry?: 'US' | 'CA';
  allocation: number;
  accountId: number;
  accountType: string;
  /** Owning goal — only required when feeding detectConflicts (which attributes
   * an over-allocated position back to the goals that share it). Optional so the
   * progress/recommendation paths, which deal with a single goal's links, needn't set it. */
  goalId?: number;
}

export interface AccountRecommendation {
  rankedTypes: string[];
  bestAccountId: number | null;
  rationale: string;
  warning?: string;
}

/**
 * Minimal shared shape between curated picks and discovery picks. Both kinds
 * surface ticker/name/currency/category to the UI so the same row template
 * renders either one — the `kind` discriminator on SecurityRecommendation
 * tells callers whether to expect a full CuratedSecurity envelope or a
 * lighter DiscoveryPick-derived one.
 */
export interface RecommendableSecurity {
  ticker: string;
  name: string;
  /** Mirrors CuratedSecurity.category for curated rows; synthesised as 'IndividualStock' for discovery rows. */
  category: SecurityCategoryLocal;
  currency: 'CAD' | 'USD';
  description: string;
  /** Mirrors CuratedSecurity.suboptimalAccounts — empty for discovery rows (no curated tax table). */
  suboptimalAccounts: AccountType[];
  /** Mirrors CuratedSecurity.navErosionRisk. Drives the UI NAV-erosion warning
   * pill on high-distribution products. null/undefined = N/A. */
  navErosionRisk?: 'low' | 'moderate' | 'high' | null;
}

export interface SecurityRecommendation {
  /** 'curated' for the curated ETF pool; 'discovery' for picks mixed in from the discovery scan. */
  kind: 'curated' | 'discovery';
  /** Shared minimal shape. Cast to CuratedSecurity when kind==='curated' for full metadata. */
  security: RecommendableSecurity;
  reason: string;
  fitScore: number;
  /** True when the security is explicitly flagged optimal for the goal's account-type context. */
  optimalForAccount: boolean;
  /** When set, the per-account tax rationale string pulled from CuratedSecurity.taxRationale. */
  taxRationale?: string;
  /** Only present when kind === 'discovery' — the underlying composite discovery score. */
  discoveryScore?: number;
  /** Yield used by the income gate and ranking, as a decimal ratio. */
  incomeYield?: number;
  /** Whether the yield came from provider metrics or the reviewed fallback registry. */
  incomeYieldSource?: 'metrics' | 'curated';
}

export interface GoalProgress {
  currentValueCad: number;
  targetCad: number;
  percentComplete: number;
  shortfallCad: number;
  monthsRemaining: number | null;
  requiredMonthlyCad: number | null;
  onTrack: boolean;
}

export interface GoalConflict {
  kind:
    | 'account-room-shortfall'
    | 'allocation-overflow'
    | 'horizon-mismatch'
    | 'risk-horizon-override';
  goalIds: number[];
  accountId?: number;
  message: string;
}

export interface GlideAllocation {
  cashPct: number;
  bondPct: number;
  equityPct: number;
}

const MS_PER_YEAR = 365.25 * 24 * 3600 * 1000;
const MS_PER_MONTH = 30.44 * 24 * 3600 * 1000;

export function horizonYears(
  goal: { targetDate: Date | null },
  now: Date = new Date(),
): number | null {
  if (!goal.targetDate) return null;
  return (goal.targetDate.getTime() - now.getTime()) / MS_PER_YEAR;
}

export function deriveRiskTolerance(goal: GoalInput, now: Date = new Date()): RiskTolerance {
  if (goal.riskOverride) return goal.riskOverride;

  const h = horizonYears(goal, now);

  if (goal.type === 'EmergencyFund') return 'VeryLow';
  if (h === null && goal.type === 'Retirement') return 'Aggressive';

  // Capital-preservation goals force VeryLow when imminent.
  const preservationTypes: GoalType[] = ['Withdrawal', 'DownPayment', 'Vacation', 'TaxBill'];
  if (preservationTypes.includes(goal.type) && h !== null && h < 2) return 'VeryLow';

  if (h === null) {
    // Open-ended non-retirement: lean on type defaults.
    if (goal.type === 'Income') return 'Low';
    return 'Moderate';
  }

  if (h < 1) return 'VeryLow';
  if (h < 3) return 'Low';
  if (h < 7) return 'Moderate';
  if (h < 15) return 'High';
  return 'Aggressive';
}

/**
 * Map a goal to ranked AccountType enum strings best→worst.
 */
// Non-registered account types day-trading should live in, best→worst.
// INVERTS the normal goal logic: registered accounts (TFSA/RRSP) are WRONG for
// frequent trading — the CRA can reclassify the activity as business income.
const DAY_TRADE_ACCOUNT_RANK: readonly string[] = ['Personal', 'Margin'];
// Registered (tax-sheltered) types that are the WRONG home for frequent trading.
// Corporate is deliberately excluded — it's non-registered and a valid trading
// home — but its tax treatment differs from an individual's, so recommendAccount
// appends a corporate caveat when it lands on one.
const REGISTERED_TYPES: ReadonlySet<string> = new Set([
  'TFSA',
  'RRSP',
  'SpousalRRSP',
  'RESP',
  'LIRA',
  'RRIF',
]);

// TFSA and RRSP are NOT the same under the ITA: a TFSA carrying on a trading
// business is taxable (s.146.2(6); Canadian Western Trust (Ahamed) v. The King,
// 2023 TCC 17), but an RRSP/RRIF is statutorily EXEMPT from business-income tax
// on qualified investments (s.146(4)(b)). The RRSP downside is different —
// withdrawal tax + lost room — not reclassification. Keep them separate.
const DAY_TRADE_RATIONALE =
  'Day-trade in a non-registered account. Frequent trading in a TFSA can be ' +
  "reclassified by the CRA as carrying on a business — making your 'tax-free' gains " +
  'fully taxable (Canadian Western Trust (Ahamed) v. The King, 2023 TCC 17). RRSPs ' +
  'are exempt from that reclassification on qualified investments, but RRSP ' +
  'withdrawals are taxed as ordinary income and permanently destroy contribution ' +
  "room, so they're still the wrong home for active trading. In a Personal/Margin " +
  'account, trading gains are business income (100% inclusion) but you can deduct ' +
  'losses and expenses, and Margin enables leverage + short-selling.';

function rankAccountTypes(goal: GoalInput, now: Date = new Date()): string[] {
  // DayTrading inverts the usual logic — non-registered only, horizon-irrelevant.
  if (goal.type === 'DayTrading') return [...DAY_TRADE_ACCOUNT_RANK];

  const h = horizonYears(goal, now);
  const isShortLiquidation =
    (['Withdrawal', 'DownPayment', 'Vacation', 'TaxBill'] as GoalType[]).includes(goal.type) &&
    h !== null &&
    h < 2;

  if (isShortLiquidation) {
    return ['TFSA', 'Personal', 'Margin'];
  }

  switch (goal.type) {
    case 'EmergencyFund':
      return ['TFSA', 'Personal'];
    case 'Income':
      return ['TFSA', 'Personal', 'RRSP', 'SpousalRRSP', 'Margin'];
    case 'Retirement':
      return ['RRSP', 'SpousalRRSP', 'TFSA', 'LIRA', 'RRIF', 'Personal', 'Margin'];
    case 'Education':
      return ['TFSA', 'Personal', 'RRSP'];
    case 'Withdrawal':
    case 'DownPayment':
    case 'Vacation':
    case 'TaxBill': {
      // Longer-horizon Withdrawal-class goals (>= 2yr): still TFSA-first but
      // open to some growth in TFSA.
      return ['TFSA', 'Personal', 'Margin'];
    }
    case 'Custom': {
      const risk = deriveRiskTolerance(goal, now);
      if (risk === 'VeryLow' || risk === 'Low') return ['TFSA', 'Personal'];
      if (risk === 'Moderate') return ['TFSA', 'RRSP', 'Personal'];
      return ['TFSA', 'RRSP', 'SpousalRRSP', 'Personal'];
    }
  }
}

function rationaleForAccount(goal: GoalInput, topType: string, now: Date = new Date()): string {
  if (goal.type === 'DayTrading') return DAY_TRADE_RATIONALE;

  const h = horizonYears(goal, now);
  const isShort = h !== null && h < 2;
  switch (goal.type) {
    case 'Withdrawal':
    case 'DownPayment':
    case 'Vacation':
    case 'TaxBill':
      if (isShort) {
        return `Withdrawing within ${Math.round((h ?? 0) * 12)} months — ${topType} keeps the cash tax-free on withdrawal and preserves your contribution room. Avoid RRSP: withdrawal triggers tax at your marginal rate and permanently destroys the room.`;
      }
      return `${topType} is the cleanest spend-toward bucket: tax-free withdrawal, no contribution-room loss, and avoids the RRSP withdrawal tax.`;
    case 'EmergencyFund':
      return `Emergency funds need to stay liquid and tax-free; ${topType} fits both criteria. Personal HISA works equally well as a backup.`;
    case 'Income':
      return `${topType} shelters ongoing dividends. For US-listed dividend payers we'd recommend an RRSP instead (treaty exemption from the 15% US withholding).`;
    case 'Retirement':
      return `Long-horizon retirement — ${topType} gives a tax deduction on contribution and shelters compounding until withdrawal.`;
    case 'Education':
      return `${topType} preserves room and tax-free gains. RESP would be better but is child-only.`;
    case 'Custom':
      return `Based on the goal's risk profile, ${topType} is the most tax-efficient placement.`;
  }
}

export function recommendAccount(
  goal: GoalInput,
  accounts: readonly AccountSummary[],
  now: Date = new Date(),
): AccountRecommendation {
  const rankedTypes = rankAccountTypes(goal, now);
  const top = rankedTypes[0]!;
  const rationale = rationaleForAccount(goal, top, now);

  if (accounts.length === 0) {
    return {
      rankedTypes,
      bestAccountId: null,
      rationale: `No accounts on file — create one first. ${rationale}`,
    };
  }

  // Walk ranked types; pick first non-archived account, prefer non-maxed.
  let bestAccountId: number | null = null;
  let warning: string | undefined;

  // DayTrading hard guard: if the user has no non-registered account, trading
  // in a registered one risks CRA business-income reclassification. Surface a
  // hard warning and point them at the best (least-bad) non-archived account.
  // Corporate is intentionally treated as non-registered (it's a valid trading
  // home) but its tax treatment differs from an individual's, so we append a
  // caveat when a Corporate account is what we land on.
  if (goal.type === 'DayTrading') {
    const live = accounts.filter((a) => !a.archived);
    const nonReg = live.filter((a) => !REGISTERED_TYPES.has(a.type));
    let dayRationale = rationale;
    if (nonReg.length === 0) {
      warning =
        'You have no non-registered account. Day-trading in a registered account ' +
        'risks CRA business-income reclassification — open a Personal/Margin account first.';
      bestAccountId = live[0]?.id ?? null;
    } else {
      // Prefer Personal over Margin (rank order), first live match wins.
      const ranked = DAY_TRADE_ACCOUNT_RANK.map((t) => nonReg.find((a) => a.type === t)).find(
        (a) => a !== undefined,
      );
      const picked = ranked ?? nonReg[0];
      bestAccountId = picked?.id ?? null;
      // AccountSummary.type is a narrowed union that predates the Corporate enum
      // value; the DB row can still be 'Corporate', so widen for the check.
      if ((picked?.type as string | undefined) === 'Corporate') {
        dayRationale +=
          ' Note: this rationale assumes a personal account — a Corporate account is ' +
          'taxed on investment income with RDTOH/integration, so confirm the corporate-tax ' +
          'treatment of your trading gains.';
      }
    }
    return { rankedTypes, bestAccountId, rationale: dayRationale, ...(warning ? { warning } : {}) };
  }

  for (const type of rankedTypes) {
    const candidates = accounts.filter((a) => a.type === type && !a.archived);
    if (candidates.length === 0) continue;
    const withRoom = candidates.filter(
      (a) => a.contributionRoomCad === null || a.contributionRoomCad > 0,
    );
    const pick = (withRoom.length > 0 ? withRoom : candidates).sort(
      (a, b) => (b.contributionRoomCad ?? 0) - (a.contributionRoomCad ?? 0),
    )[0]!;
    bestAccountId = pick.id;
    break;
  }

  if (bestAccountId === null) {
    // No account of any preferred type — check if user only has RRSP-family
    // accounts but goal is a withdrawal-class.
    const isWithdrawalClass = (
      ['Withdrawal', 'DownPayment', 'Vacation', 'TaxBill', 'EmergencyFund'] as GoalType[]
    ).includes(goal.type);
    const onlyRrspFamily = accounts.every((a) =>
      ['RRSP', 'SpousalRRSP', 'LIRA', 'RRIF'].includes(a.type),
    );
    if (isWithdrawalClass && onlyRrspFamily && accounts.length > 0) {
      warning = `Your only accounts are RRSP-family. Withdrawing from an RRSP would trigger tax at your marginal rate and permanently lose the contribution room.`;
      bestAccountId = accounts.find((a) => !a.archived)?.id ?? null;
    } else {
      bestAccountId = accounts.find((a) => !a.archived)?.id ?? null;
    }
  }

  return { rankedTypes, bestAccountId, rationale, ...(warning ? { warning } : {}) };
}

/**
 * Base palette per risk tolerance — used by the stage-2 picker in
 * `categoriesForGoal`. The slider drives this directly, so users see the
 * recommendation change when they move it.
 */
function riskPalette(risk: RiskTolerance): SecurityCategoryLocal[] {
  switch (risk) {
    case 'VeryLow':
      return ['CashEquivalent', 'ShortTermBond'];
    case 'Low':
      return [
        'CashEquivalent',
        'ShortTermBond',
        'IntermediateBond',
        'Balanced',
        'DividendCanadian',
      ];
    case 'Moderate':
      return [
        'IntermediateBond',
        'Balanced',
        'Growth',
        'DividendCanadian',
        'DividendUS',
        'EquityUS',
      ];
    case 'High':
      return [
        'Balanced',
        'Growth',
        'AllEquity',
        'EquityUS',
        'EquityInternational',
        'EquityEmerging',
        'SectorEquity',
        'DividendCanadian',
        'DividendUS',
        'REIT',
      ];
    case 'Aggressive':
      return [
        'AllEquity',
        'EquityUS',
        'EquityInternational',
        'EquityEmerging',
        'Growth',
        'SectorEquity',
        'IndividualStock',
        'Speculative',
        'CryptoAdjacent',
        'LeveragedETF',
        'DividendUS',
        'REIT',
        'DividendCanadian',
      ];
  }
}

/**
 * Income-goal palette by risk — yield-oriented at every level.
 */
function incomePalette(risk: RiskTolerance): SecurityCategoryLocal[] {
  switch (risk) {
    case 'VeryLow':
      return ['CashEquivalent', 'ShortTermBond'];
    case 'Low':
      return ['ShortTermBond', 'IntermediateBond', 'Balanced', 'DividendCanadian'];
    case 'Moderate':
      return ['Balanced', 'DividendCanadian', 'DividendUS', 'REIT'];
    case 'High':
      return ['CoveredCall', 'DividendCanadian', 'DividendUS', 'REIT'];
    case 'Aggressive':
      return ['CoveredCall', 'DividendUS', 'REIT', 'DividendCanadian'];
  }
}

function growthPalette(risk: RiskTolerance): SecurityCategoryLocal[] {
  switch (risk) {
    case 'VeryLow':
      return ['CashEquivalent', 'ShortTermBond'];
    case 'Low':
      return ['ShortTermBond', 'IntermediateBond', 'Balanced'];
    case 'Moderate':
      return ['Balanced', 'Growth', 'EquityUS', 'EquityInternational'];
    case 'High':
      return [
        'Growth',
        'AllEquity',
        'EquityUS',
        'EquityInternational',
        'EquityEmerging',
        'SectorEquity',
      ];
    case 'Aggressive':
      return [
        'AllEquity',
        'EquityUS',
        'EquityInternational',
        'EquityEmerging',
        'Growth',
        'SectorEquity',
        'IndividualStock',
        'Speculative',
        'CryptoAdjacent',
        'LeveragedETF',
      ];
  }
}

function balancedPalette(risk: RiskTolerance): SecurityCategoryLocal[] {
  switch (risk) {
    case 'VeryLow':
      return ['CashEquivalent', 'ShortTermBond'];
    case 'Low':
      return ['CashEquivalent', 'ShortTermBond', 'IntermediateBond', 'Balanced'];
    case 'Moderate':
      return ['IntermediateBond', 'Balanced', 'Growth', 'DividendCanadian', 'EquityUS'];
    case 'High':
      return [
        'IntermediateBond',
        'Balanced',
        'Growth',
        'AllEquity',
        'EquityUS',
        'EquityInternational',
        'DividendCanadian',
      ];
    case 'Aggressive':
      return [
        'Balanced',
        'Growth',
        'AllEquity',
        'EquityUS',
        'EquityInternational',
        'EquityEmerging',
        'SectorEquity',
        'IndividualStock',
        'Speculative',
      ];
  }
}

function uniqueCategories(cats: readonly SecurityCategoryLocal[]): SecurityCategoryLocal[] {
  return [...new Set(cats)];
}

const PURE_EQUITY_CATEGORIES: ReadonlySet<SecurityCategoryLocal> = new Set([
  'AllEquity',
  'EquityUS',
  'EquityInternational',
  'EquityEmerging',
  'Growth',
  // Phase 18 — equally aggressive shapes that must be stripped on short
  // withdrawal horizons.
  'IndividualStock',
  'LeveragedETF',
  'SectorEquity',
  'Speculative',
  'CryptoAdjacent',
]);

// Categories considered "growth-shaped" — used by the Growth strategy overlay
// to bias toward appreciation rather than yield.
const GROWTH_CATEGORIES: ReadonlySet<SecurityCategoryLocal> = new Set([
  'AllEquity',
  'Growth',
  'EquityUS',
  'EquityCanadian',
  'EquityInternational',
  'EquityEmerging',
  'IndividualStock',
  'LeveragedETF',
  'SectorEquity',
  'Speculative',
  'CryptoAdjacent',
]);

const DIVIDEND_CATEGORIES: ReadonlySet<SecurityCategoryLocal> = new Set([
  'DividendCanadian',
  'DividendUS',
  'REIT',
  // Covered-call/BDC/HY are yield-shaped — Growth strategy must drop them so
  // an Aggressive+Growth goal stays growth-tilted, not pulled to high yield.
  'CoveredCall',
]);

function categoriesForGoal(goal: GoalInput, now: Date = new Date()): SecurityCategoryLocal[] {
  const h = horizonYears(goal, now);
  const risk = deriveRiskTolerance(goal, now);
  // An explicit riskOverride is a conscious signal that must win over the
  // horizon-based de-risking below. When set, the short-horizon cash/equity-strip
  // guardrails are bypassed so the user gets the palette their risk+strategy
  // imply. EmergencyFund is the one carve-out: it stays cash-locked regardless
  // (definitional, handled by its own unconditional return below).
  const hasExplicitRisk = goal.riskOverride != null;

  // Stage 1 — Hard constraints: capital preservation overrides risk AND strategy.
  // These are non-negotiable (you can't put EmergencyFund money in equities even
  // if the user picked Growth strategy).
  const withdrawalClass = (
    ['Withdrawal', 'DownPayment', 'Vacation', 'TaxBill'] as GoalType[]
  ).includes(goal.type);
  // Explicit override wins: only hard-cap to cash when risk is horizon-derived.
  if (!hasExplicitRisk && withdrawalClass && h !== null && h < 1) return ['CashEquivalent'];
  if (goal.type === 'EmergencyFund') return ['CashEquivalent'];

  // Stage 1.5 — Strategy axis overlay. Sits between hard constraints and the
  // type/risk fallback so an explicit strategy choice ("I want growth on this
  // Retirement goal") wins over the type's default palette.
  const strategy = goal.strategy ?? null;

  if (strategy === 'Preservation') {
    // Capital preservation regardless of type/risk. Cash + short bonds only.
    return ['CashEquivalent', 'ShortTermBond'];
  }

  if (strategy === 'Income') {
    // Income strategy reuses the yield-by-risk palette — same logic that
    // type=Income already runs. Education still drops emerging markets.
    // Explicit override wins: skip the horizon-driven sub-2yr cash strip when
    // the user set risk — they get incomePalette(risk) (e.g. Aggressive income).
    if (!hasExplicitRisk && goal.type === 'Education' && h !== null && h < 2) {
      return ['CashEquivalent', 'ShortTermBond'];
    }
    return incomePalette(risk);
  }

  if (strategy === 'Growth') {
    // Withdrawal/Education guardrails still apply unless the user set an
    // explicit risk, in which case the horizon-driven equity strip is bypassed
    // and the full growth-by-risk palette flows through.
    let base = growthPalette(risk);
    if (!hasExplicitRisk && withdrawalClass && h !== null && h < 3) {
      const filtered = base.filter((c) => !PURE_EQUITY_CATEGORIES.has(c));
      if (filtered.length === 0) return ['CashEquivalent', 'ShortTermBond'];
      base = filtered;
    }
    if (!hasExplicitRisk && goal.type === 'Education' && h !== null && h < 2) {
      return ['CashEquivalent', 'ShortTermBond'];
    }
    return uniqueCategories(
      goal.type === 'Education' ? base.filter((c) => c !== 'EquityEmerging') : base,
    );
  }

  if (strategy === 'Balanced') {
    let base = balancedPalette(risk);
    // Explicit override wins: only strip pure equity on a short withdrawal
    // horizon when the risk is horizon-derived.
    const stripShortEquity = !hasExplicitRisk && withdrawalClass && h !== null && h < 3;
    if (stripShortEquity) {
      base = base.filter((c) => !PURE_EQUITY_CATEGORIES.has(c));
      if (base.length === 0) base = ['CashEquivalent', 'ShortTermBond'];
    }
    if (goal.type === 'Education') {
      base = base.filter((c) => c !== 'EquityEmerging');
    }
    return uniqueCategories(base.length > 0 ? base : ['Balanced']);
  }

  // Stage 2/3 — No strategy set: existing type → risk → categories logic.

  // Income — always yield-focused per risk tier.
  if (goal.type === 'Income') return incomePalette(risk);

  // Education — risk palette but no emerging markets; sub-2yr → cash (skipped
  // when the user set an explicit risk; the EquityEmerging drop is not
  // horizon-driven so it always applies).
  if (goal.type === 'Education') {
    if (!hasExplicitRisk && h !== null && h < 2) return ['CashEquivalent', 'ShortTermBond'];
    return riskPalette(risk).filter((c) => c !== 'EquityEmerging');
  }

  // Withdrawal-class with 1-3yr horizon: strip pure equity from the palette —
  // unless the user set an explicit risk, in which case their full palette wins.
  if (!hasExplicitRisk && withdrawalClass && h !== null && h < 3) {
    const filtered = riskPalette(risk).filter((c) => !PURE_EQUITY_CATEGORIES.has(c));
    if (filtered.length === 0) return ['CashEquivalent', 'ShortTermBond'];
    return filtered;
  }

  // Retirement / Custom / Withdrawal-class with no horizon or > 3yr → palette as-is.
  return riskPalette(risk);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// --- Continuous fit-score components (replace the old discrete thresholds) ----
// The categorical tilts (currency / account / strategy / risk) are coarse and
// the same across a category cohort, so on their own the fit score collapses to
// a couple of clamped buckets. These continuous functions of the security's own
// MER / yield / discovery score spread same-cohort holdings along a real gradient.

// MER → fit. Linear in the actual MER: a top-anchor of +12 at 0% slopes down to
// -4 at 0.40%+, so real ETF MERs (0.03%-0.65%) fan out (0.03%→+10.8, 0.20%→+4,
// 0.40%+→-4). Cheaper is better — fee drag compounds against every goal.
function merFitContribution(mer: number | null): number {
  if (mer === null) return 0; // individual stocks carry no MER → neutral
  return clamp(12 - mer * 4000, -4, 12);
}

// Yield → fit, Income-only. Continuous in expectedYield so a 4% / 6% / 8% payer
// land at distinct points instead of all clearing one threshold. Gated to Income
// type/strategy so yield never inflates a growth goal's ranking.
function yieldFitContribution(expectedYield: number | null): number {
  if (expectedYield === null) return 0;
  return clamp(expectedYield * 120, 0, 10);
}

function resolveIncomeYield(
  ticker: string,
  fallback: number | null,
  overrides: Record<string, number> | undefined,
): { value: number | null; source: 'metrics' | 'curated' | null } {
  const override = overrides?.[ticker.toUpperCase()];
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
    return { value: override, source: 'metrics' };
  }
  return {
    value: fallback,
    source: fallback !== null && fallback > 0 ? 'curated' : null,
  };
}

function formatIncomeYield(value: number): string {
  return Number((value * 100).toFixed(1)).toString();
}

function withIncomeYieldEvidence(
  reason: string,
  value: number | null | undefined,
  source: 'metrics' | 'curated' | null | undefined,
): string {
  if (value === null || value === undefined || value <= 0 || !source) return reason;
  const evidence =
    source === 'metrics'
      ? `~${formatIncomeYield(value)}% reported TTM yield`
      : `~${formatIncomeYield(value)}% reviewed yield estimate`;
  return `${evidence}. ${reason}`;
}

// Discovery score -> fit. The stored composite is roughly 0-10, while this
// component owns at most eight fit points. Normalize first so scores above 4
// do not all collapse into the same clamped bonus. Missing stays neutral.
function discoveryFitContribution(score: number | undefined): number {
  if (score === undefined) return 0;
  return clamp(discoveryScoreToRotationSignal(score) * 8, -6, 8);
}

type RiskRating = 1 | 2 | 3 | 4 | 5;

function securityRiskRating(s: CuratedSecurity): RiskRating {
  if (s.riskRating) return s.riskRating;

  switch (s.category as SecurityCategoryLocal) {
    case 'CashEquivalent':
      return 1;
    case 'ShortTermBond':
    case 'IntermediateBond':
      return 2;
    case 'Balanced':
      if ((s.equityPct ?? 60) <= 40) return 2;
      return 3;
    case 'Growth':
    case 'AllEquity':
    case 'EquityUS':
    case 'EquityInternational':
    case 'DividendCanadian':
    case 'DividendUS':
      return 3;
    case 'EquityEmerging':
    case 'SectorEquity':
    case 'REIT':
    case 'IndividualStock':
      return 4;
    case 'Speculative':
    case 'CryptoAdjacent':
    case 'LeveragedETF':
    case 'CoveredCall':
      return 5;
    case 'EquityCanadian':
    case 'Other':
      return 3;
  }
}

function riskFitContribution(rating: RiskRating, risk: RiskTolerance): number {
  switch (risk) {
    case 'VeryLow':
      if (rating === 1) return 12;
      if (rating === 2) return 4;
      return -24;
    case 'Low':
      if (rating === 1) return 4;
      if (rating === 2) return 12;
      if (rating === 3) return 0;
      return rating === 4 ? -18 : -26;
    case 'Moderate':
      if (rating === 2) return 3;
      if (rating === 3) return 12;
      if (rating === 4) return -4;
      return rating === 1 ? -5 : -18;
    case 'High':
      if (rating === 3) return 9;
      if (rating === 4) return 10;
      if (rating === 5) return -8;
      return -10;
    case 'Aggressive':
      if (rating === 5) return 14;
      if (rating === 4) return 10;
      if (rating === 3) return 3;
      return -22;
  }
}

function targetEquityPctForRisk(risk: RiskTolerance): number {
  switch (risk) {
    case 'VeryLow':
      return 0;
    case 'Low':
      return 30;
    case 'Moderate':
      return 60;
    case 'High':
      return 80;
    case 'Aggressive':
      return 100;
  }
}

function allocationFitContribution(s: CuratedSecurity, risk: RiskTolerance): number {
  if (typeof s.equityPct !== 'number') return 0;
  const diff = Math.abs(s.equityPct - targetEquityPctForRisk(risk));
  return clamp(8 - diff / 5, -8, 8);
}

function effectiveStrategy(goal: GoalInput): GoalStrategy | null {
  if (goal.strategy) return goal.strategy;
  if (goal.type === 'Income') return 'Income';
  return null;
}

function satelliteCategoriesFor(goal: GoalInput, risk: RiskTolerance): SecurityCategoryLocal[] {
  const strategy = effectiveStrategy(goal);
  if (strategy === 'Preservation') return [];

  if (risk === 'High') {
    if (strategy === 'Income') return ['CoveredCall'];
    if (strategy === 'Growth') return ['EquityEmerging', 'SectorEquity'];
    return ['EquityEmerging', 'SectorEquity', 'REIT'];
  }

  if (risk === 'Aggressive') {
    if (strategy === 'Income') return ['CoveredCall'];
    if (strategy === 'Growth') {
      return ['LeveragedETF', 'Speculative', 'CryptoAdjacent', 'SectorEquity', 'IndividualStock'];
    }
    if (strategy === 'Balanced') return ['EquityEmerging', 'SectorEquity', 'Speculative'];
    return ['LeveragedETF', 'Speculative', 'CryptoAdjacent', 'SectorEquity'];
  }

  return [];
}

function withSatelliteSlot(
  recs: readonly SecurityRecommendation[],
  limit: number,
  goal: GoalInput,
  risk: RiskTolerance,
): SecurityRecommendation[] {
  const picked = recs.slice(0, limit);
  const satCats = satelliteCategoriesFor(goal, risk);
  if (satCats.length === 0 || picked.length === 0) return picked;

  const hasSatellite = picked.some((r) =>
    satCats.includes(r.security.category as SecurityCategoryLocal),
  );
  if (hasSatellite) return picked;

  const pickedTickers = new Set(picked.map((r) => r.security.ticker.toUpperCase()));
  const satellite = recs.find(
    (r) =>
      satCats.includes(r.security.category as SecurityCategoryLocal) &&
      !pickedTickers.has(r.security.ticker.toUpperCase()),
  );
  if (!satellite) return picked;

  if (picked.length < limit) picked.push(satellite);
  else picked[picked.length - 1] = satellite;

  picked.sort((a, b) => b.fitScore - a.fitScore);
  return picked;
}

export function recommendSecurities(
  goal: GoalInput,
  opts: {
    limit?: number;
    usdSubAccountAvailable?: boolean;
    /**
     * The account type the goal is funded from. When provided, the engine
     * applies Canadian-tax-aware bonuses/penalties: optimal accounts get +15,
     * suboptimal accounts get -15, and the per-account tax rationale is
     * threaded onto the SecurityRecommendation. Corporate accounts route
     * through Personal tax logic (integrated tax — owner ends up taxed at
     * the personal level anyway).
     */
    goalAccountType?: AccountType;
    /**
     * Discovery-scored individual tickers (loaded async by the caller via
     * `loadTopDiscoveryPicks`). Engine stays sync/pure — caller does the DB
     * work and passes the picks in. Only merged in when
     * `includeDiscoveryPicks !== false` AND derived risk is High/Aggressive.
     */
    discoveryPicks?: readonly DiscoveryPick[];
    /**
     * Explicit gate for the discovery merge. Defaults to true when risk is
     * High/Aggressive, false otherwise. Tests use the explicit `false` to
     * verify the curated-only path still works.
     */
    includeDiscoveryPicks?: boolean;
    /**
     * Latest composite DiscoveryScore per ticker (raw, roughly 0-10),
     * keyed by UPPER-cased ticker. Folded continuously into the curated fit so
     * the score isn't dominated by the saturating categorical tilts. The engine
     * stays pure — `data.ts` runs the DiscoveryScore query and passes this in.
     * Tickers absent from the map contribute 0 (neutral). Most curated ETFs
     * have no DiscoveryScore row (the scanner biases to US large-caps), so this
     * mainly differentiates the individual-stock picks; MER + yield are the
     * guaranteed granularity drivers for the ETF cohorts.
     */
    discoveryScoreByTicker?: Record<string, number>;
    /**
     * Latest positive TTM distribution yield per ticker as a ratio (0.085 is
     * 8.5%). Overrides the curated review-time estimate for income gates,
     * ranking, and rationale. Missing or invalid values keep the curated
     * estimate as the explicit degraded-data fallback.
     */
    incomeYieldByTicker?: Record<string, number>;
  } = {},
  now: Date = new Date(),
): SecurityRecommendation[] {
  // DayTrading does not use the curated buy-and-hold pool — candidates come from
  // the day-trade scanner (DB-querying, lives in dayTradeScanner.ts). Bypass.
  if (goal.type === 'DayTrading') return [];

  const limit = opts.limit ?? 5;
  const cats = categoriesForGoal(goal, now);
  const incomeFlavoured = goal.type === 'Income' || goal.strategy === 'Income';
  const risk = deriveRiskTolerance(goal, now);
  const incomeRiskKey = GOAL_INCOME_RISK_KEYS[risk];
  const incomeProfile = INCOME_RISK_PROFILES[incomeRiskKey];
  const incomeYieldSourceByTicker = new Map<string, 'metrics' | 'curated'>();
  const pool = poolByCategories(...cats)
    .map((security) => {
      const resolvedYield = resolveIncomeYield(
        security.ticker,
        security.expectedYield,
        opts.incomeYieldByTicker,
      );
      if (resolvedYield.source) {
        incomeYieldSourceByTicker.set(security.ticker.toUpperCase(), resolvedYield.source);
      }
      return resolvedYield.value === security.expectedYield
        ? security
        : { ...security, expectedYield: resolvedYield.value };
    })
    .filter((security) => {
      if (!incomeFlavoured) return true;
      return (
        MONTHLY_INCOME_TICKERS.has(security.ticker.toUpperCase()) &&
        incomeRiskAllows(incomeRiskKey, incomeRiskFloorForSecurity(security)) &&
        (security.expectedYield ?? 0) >= incomeProfile.minYield
      );
    });

  // Corporate → Personal for tax math (integrated taxation).
  const taxAccount: AccountType | undefined =
    opts.goalAccountType === 'Corporate' ? 'Personal' : opts.goalAccountType;

  const discScores = opts.discoveryScoreByTicker;
  // Income type OR Income strategy → apply the continuous yield emphasis. Growth
  // goals deliberately omit it so a high distribution can't out-rank real growth.
  const strategy = goal.strategy ?? null;

  const recs: SecurityRecommendation[] = pool.map((s) => {
    // Leave enough headroom for currency, account, risk, fee, and yield terms
    // to remain visible instead of clamping an entire favoured cohort at 100.
    let fit = 40;
    const preferUsd = !!opts.usdSubAccountAvailable && cats.includes('DividendUS');
    const goalCurrency = preferUsd ? 'USD' : 'CAD';
    if (s.currency === goalCurrency) fit += 10;

    // Continuous fee + discovery contributions apply to every goal type.
    fit += merFitContribution(s.mer);
    fit += discoveryFitContribution(discScores?.[s.ticker.toUpperCase()]);
    fit += riskFitContribution(securityRiskRating(s), risk);
    fit += allocationFitContribution(s, risk);

    // Continuous yield emphasis — Income type/strategy only.
    if (incomeFlavoured) fit += yieldFitContribution(s.expectedYield);
    if (
      (
        ['Withdrawal', 'DownPayment', 'Vacation', 'TaxBill', 'EmergencyFund'] as GoalType[]
      ).includes(goal.type) &&
      s.category === 'CashEquivalent'
    ) {
      fit += 5;
    }

    if (strategy === 'Income') {
      if (
        s.category === 'DividendCanadian' ||
        s.category === 'DividendUS' ||
        s.category === 'REIT' ||
        s.category === 'CoveredCall'
      ) {
        fit += 10;
      }
    } else if (strategy === 'Growth') {
      if (GROWTH_CATEGORIES.has(s.category as SecurityCategoryLocal)) fit += 8;
      if (satelliteCategoriesFor(goal, risk).includes(s.category as SecurityCategoryLocal))
        fit += 6;
      if (s.category === 'IndividualStock' && s.expectedYield !== null && s.expectedYield > 0.025) {
        fit -= 10;
      }
      if (DIVIDEND_CATEGORIES.has(s.category as SecurityCategoryLocal)) fit -= 10;
    } else if (strategy === 'Preservation') {
      if (s.category === 'CashEquivalent') fit += 12;
      if (s.category === 'ShortTermBond') fit += 8;
      if (PURE_EQUITY_CATEGORIES.has(s.category as SecurityCategoryLocal)) fit -= 16;
    } else if (strategy === 'Balanced') {
      if (typeof s.equityPct === 'number') fit += 4;
      if (s.category === 'IntermediateBond' || s.category === 'DividendCanadian') fit += 2;
      if (
        s.category === 'LeveragedETF' ||
        s.category === 'CryptoAdjacent' ||
        s.category === 'CoveredCall'
      ) {
        fit -= 8;
      }
    }

    if (risk === 'VeryLow') {
      if (s.durationYears === 0) fit += 8;
      if (s.durationYears !== null && s.durationYears > 3) fit -= 8;
    } else if (risk === 'Aggressive') {
      if (s.category === 'CashEquivalent' || s.category === 'ShortTermBond') fit -= 10;
    } else if (risk === 'High') {
      if (s.category === 'AllEquity' || s.category === 'Growth') fit += 4;
      if (satelliteCategoriesFor(goal, risk).includes(s.category as SecurityCategoryLocal))
        fit += 3;
    } else if (risk === 'Low') {
      if (s.category === 'Balanced' || s.category === 'IntermediateBond') fit += 4;
    }

    // NAV-erosion penalty — for high-distribution products (covered-call/BDC/HY)
    // we rank by SUSTAINABLE yield. The danger isn't the headline yield, it's
    // distributions funded by return-of-capital while the fund bleeds NAV. So a
    // leveraged yield-trap (HDIV, 'high') is pushed below sustainable spread-based
    // income (QQQI/JEPI, 'low') even though it advertises a similar number.
    if (s.navErosionRisk === 'high') fit -= 12;
    else if (s.navErosionRisk === 'moderate') fit -= 4;

    // Account-type tax-aware adjustment. The big driver of the new behaviour:
    // swapping accounts on the same goal must produce a visibly different set.
    let optimalForAccount = false;
    let taxRationaleStr: string | undefined;
    if (taxAccount) {
      if (s.optimalAccounts.includes(taxAccount)) {
        fit += 15;
        optimalForAccount = true;
      }
      if (s.suboptimalAccounts.includes(taxAccount)) {
        fit -= 15;
      }
      const match = s.taxRationale?.find((r) => r.account === taxAccount);
      if (match) taxRationaleStr = match.reason;

      // Phase 18 — extra emphasis: in Aggressive, the category-vs-account
      // alignment matters more than for moderate goals. Push the explicitly
      // tax-flavoured picks above broad index ETFs (which are merely "fine
      // everywhere") so the top-3 actually reshuffles by account.
      if (risk === 'Aggressive') {
        const rrspFamily = (['RRSP', 'SpousalRRSP', 'LIRA', 'RRIF'] as AccountType[]).includes(
          taxAccount,
        );
        // RRSP family → US dividend ETFs and US REITs are the headline picks.
        if (
          strategy !== 'Growth' &&
          rrspFamily &&
          (s.category === 'DividendUS' || s.category === 'REIT')
        ) {
          fit += 8;
        }
        // RRSP family → US covered-call/BDC/HY (ordinary-income distributions
        // belong in registered). Canadian covered-call (Cdn dividends) → the
        // non-reg/TFSA wrappers, mirroring the Cdn-dividend-champion logic.
        if (rrspFamily && s.category === 'CoveredCall' && s.currency === 'USD') {
          fit += 8;
        }
        if (
          (taxAccount === 'Personal' || taxAccount === 'Margin' || taxAccount === 'TFSA') &&
          s.category === 'CoveredCall' &&
          s.currency === 'CAD'
        ) {
          fit += 2;
        }
        // TFSA → individual high-growth, leveraged, sector, speculative, crypto.
        if (
          taxAccount === 'TFSA' &&
          (
            [
              'IndividualStock',
              'LeveragedETF',
              'SectorEquity',
              'Speculative',
              'CryptoAdjacent',
            ] as SecurityCategoryLocal[]
          ).includes(s.category as SecurityCategoryLocal) &&
          s.currency === 'USD' // bias toward the US-listed growth names; CAD individual stocks land in Personal
        ) {
          fit += 6;
        }
        // Personal/Margin → Canadian eligible dividend champions (CAD-listed
        // IndividualStock with a real yield, not the zero-yield growth names).
        if (
          (taxAccount === 'Personal' || taxAccount === 'Margin') &&
          strategy !== 'Growth' &&
          s.category === 'IndividualStock' &&
          s.currency === 'CAD' &&
          s.expectedYield !== null &&
          s.expectedYield > 0.025
        ) {
          fit += 8;
        }
      }
    }

    // Round after clamping — the continuous MER/yield/discovery terms produce
    // fractional fits; the UI wants a clean integer "NN/100". The spread now
    // lives in the inputs, not the rounding, so distinct holdings stay distinct.
    fit = Math.round(clamp(fit, 0, 100));

    const incomeYieldSource = incomeYieldSourceByTicker.get(s.ticker.toUpperCase());
    const reason = incomeFlavoured
      ? withIncomeYieldEvidence(
          buildSecurityReason(goal, s, cats, now),
          s.expectedYield,
          incomeYieldSource,
        )
      : buildSecurityReason(goal, s, cats, now);
    const out: SecurityRecommendation = {
      kind: 'curated',
      security: s,
      reason,
      fitScore: fit,
      optimalForAccount,
    };
    if (taxRationaleStr) out.taxRationale = taxRationaleStr;
    if (incomeFlavoured && s.expectedYield !== null && s.expectedYield > 0 && incomeYieldSource) {
      out.incomeYield = s.expectedYield;
      out.incomeYieldSource = incomeYieldSource;
    }
    return out;
  });

  // Discovery picks — mix in individual-ticker high-conviction names when the
  // goal can stomach the volatility (High/Aggressive). Curated ETFs still
  // dominate the broad allocation; discovery picks are the "satellite" sleeve.
  const mergeDiscovery = opts.includeDiscoveryPicks ?? (risk === 'High' || risk === 'Aggressive');
  const discoveryRecs: SecurityRecommendation[] = [];
  if (mergeDiscovery && opts.discoveryPicks && opts.discoveryPicks.length > 0) {
    // Dedupe against curated tickers in case both pools picked the same name
    // (e.g. NVDA is in both the curated IndividualStock set and the discovery
    // scan). The curated entry wins because it carries the full tax table.
    for (const pick of opts.discoveryPicks) {
      const ticker = pick.ticker.toUpperCase();
      // Curated metadata remains authoritative even when a product was
      // intentionally filtered out by this goal's income floor.
      if (findCurated(ticker)) continue;
      if (incomeFlavoured) {
        if (!MONTHLY_INCOME_TICKERS.has(ticker)) continue;
        const fallback = monthlyIncomeFallback(ticker);
        const expectedYield = resolveIncomeYield(
          ticker,
          pick.incomeYield ?? fallback?.expectedYield ?? null,
          opts.incomeYieldByTicker,
        ).value;
        const riskFloor = fallback?.riskFloor ?? 'aggressive';
        if (
          !incomeRiskAllows(incomeRiskKey, riskFloor) ||
          (expectedYield ?? 0) < incomeProfile.minYield
        ) {
          continue;
        }
      }
      // Defense-in-depth: the loader already filters the YieldMax blocklist, but
      // never surface a yield-trap even if a caller passes one in directly.
      if (isYieldTrap(pick.ticker)) continue;
      discoveryRecs.push(buildDiscoveryRecommendation(pick, goal, taxAccount));
    }
  }

  recs.sort((a, b) => b.fitScore - a.fitScore);
  discoveryRecs.sort((a, b) => b.fitScore - a.fitScore);

  if (discoveryRecs.length === 0) {
    return withSatelliteSlot(recs, limit, goal, risk);
  }

  // Reserve ~30% of the slot budget for discovery picks so the curated leaders
  // (which saturate fit=100 for broad-equity ETFs and dividend champions)
  // don't crowd the entire list. Floor at 1, ceiling so curated still wins
  // the majority of slots — discovery is a satellite, not the headline.
  const discoveryQuota = Math.max(1, Math.min(discoveryRecs.length, Math.floor(limit * 0.3)));
  const curatedQuota = limit - discoveryQuota;
  const picked: SecurityRecommendation[] = [
    ...withSatelliteSlot(recs, curatedQuota, goal, risk),
    ...discoveryRecs.slice(0, discoveryQuota),
  ];
  picked.sort((a, b) => b.fitScore - a.fitScore);
  return picked;
}

/**
 * Score a discovery pick into a SecurityRecommendation. The formula is shaped
 * around the composite discovery score plus an account-tax-fit bonus mirroring
 * the curated logic. Income picks also carry the exact yield evidence used by
 * the loader's risk gate.
 */
function buildDiscoveryRecommendation(
  pick: DiscoveryPick,
  goal: GoalInput,
  taxAccount: AccountType | undefined,
): SecurityRecommendation {
  // Composite discovery scores land in roughly [0, 10] for healthy tickers
  // (see packages/core/src/discover/signals.ts). Scale at 4 so a strong pick
  // (score≈8+) earns ~+32 from score alone; the account-fit bonus then lifts it
  // into the same high-90s neighbourhood as a top curated pick. Base lowered
  // 60 → 48 in step with the curated base drop so discovery picks stay
  // comparable to (not auto-above) curated — the 30% quota already guarantees
  // they surface as the satellite sleeve.
  let fit = 48 + Math.min(Math.max(pick.score, 0), 10) * 4;

  // Goal-currency alignment — small bonus, mirrors curated logic.
  const goalCurrency: 'CAD' | 'USD' = 'CAD';
  if (pick.currency === goalCurrency) fit += 5;

  // Account-tax fit. The big driver of "swap the account → top picks shift".
  let optimalForAccount = false;
  if (taxAccount) {
    const rrspFamily = (['RRSP', 'SpousalRRSP', 'LIRA', 'RRIF'] as AccountType[]).includes(
      taxAccount,
    );
    if ((taxAccount === 'TFSA' || taxAccount === 'RESP') && !pick.isUsDivPayer) {
      fit += 15;
      optimalForAccount = true;
    }
    if (rrspFamily && pick.isUsDivPayer) {
      fit += 15;
      optimalForAccount = true;
    }
    if (
      (taxAccount === 'Personal' || taxAccount === 'Margin' || taxAccount === 'Corporate') &&
      pick.listingCountry === 'CA'
    ) {
      fit += 15;
      optimalForAccount = true;
    }
    // Penalty: US div payer landing in TFSA/RESP is the canonical "wrong
    // wrapper" — the 15% withholding leak is unrecoverable.
    if (pick.isUsDivPayer && (taxAccount === 'TFSA' || taxAccount === 'RESP')) fit -= 10;
  }

  fit = Math.round(clamp(fit, 0, 100));

  const incomeFlavoured = goal.type === 'Income' || goal.strategy === 'Income';
  const reason = incomeFlavoured
    ? withIncomeYieldEvidence(
        buildDiscoveryReason(pick, taxAccount),
        pick.incomeYield,
        pick.incomeYieldSource,
      )
    : buildDiscoveryReason(pick, taxAccount);
  const out: SecurityRecommendation = {
    kind: 'discovery',
    security: {
      ticker: pick.ticker,
      name: pick.name ?? pick.ticker,
      // All discovery picks are individual tickers — tag them as such so the
      // UI can treat them uniformly alongside curated IndividualStock rows.
      category: 'IndividualStock',
      currency: pick.currency,
      description: pick.sector
        ? `${pick.sector} — discovery score ${pick.score.toFixed(2)}`
        : `Discovery pick — score ${pick.score.toFixed(2)}`,
      // Discovery picks don't carry a curated tax table; UI falls back to
      // the engine-supplied `taxRationale` reason line below.
      suboptimalAccounts: [],
    },
    reason,
    fitScore: fit,
    optimalForAccount,
    discoveryScore: pick.score,
  };
  if (
    incomeFlavoured &&
    pick.incomeYield !== null &&
    pick.incomeYield !== undefined &&
    pick.incomeYield > 0 &&
    pick.incomeYieldSource
  ) {
    out.incomeYield = pick.incomeYield;
    out.incomeYieldSource = pick.incomeYieldSource;
  }
  // Inline a short tax rationale so the UI can surface it next to the curated
  // ones. Goal type is unused right now but threaded for future expansion.
  void goal;
  return out;
}

function buildDiscoveryReason(pick: DiscoveryPick, taxAccount: AccountType | undefined): string {
  const score = pick.score.toFixed(2);
  if (taxAccount === 'TFSA' || taxAccount === 'RESP') {
    if (pick.isUsDivPayer) {
      return `Discovery pick (score ${score}) — US dividend payer; 15% withholding leaks in ${taxAccount}, prefer holding elsewhere.`;
    }
    return `Individual growth pick from your discovery scan (score ${score}) — high-conviction name, capital gains tax-free in ${taxAccount}.`;
  }
  if (
    taxAccount === 'RRSP' ||
    taxAccount === 'SpousalRRSP' ||
    taxAccount === 'LIRA' ||
    taxAccount === 'RRIF'
  ) {
    if (pick.isUsDivPayer) {
      return `Discovery pick (score ${score}) — US dividend payer; treaty exemption from withholding makes ${taxAccount} the optimal wrapper.`;
    }
    return `Discovery pick (score ${score}) — tax-deferred compounding inside ${taxAccount}.`;
  }
  if (taxAccount === 'Personal' || taxAccount === 'Margin' || taxAccount === 'Corporate') {
    if (pick.listingCountry === 'CA' && pick.hasDividend) {
      return `Discovery pick (score ${score}) — Canadian eligible dividend, ideal for non-registered tax credit.`;
    }
    if (pick.listingCountry === 'CA') {
      return `Discovery pick (score ${score}) — Canadian-listed; no FTC paperwork in non-registered.`;
    }
    return `Discovery pick (score ${score}) — capital-gains-shaped name; only 50% of gains are taxable in non-reg.`;
  }
  return `Discovery pick (score ${score}) — high-conviction individual name from the discovery scan.`;
}

function buildSecurityReason(
  goal: GoalInput,
  s: CuratedSecurity,
  cats: readonly SecurityCategoryLocal[],
  now: Date,
): string {
  const h = horizonYears(goal, now);
  if (cats[0] === 'CashEquivalent') {
    return `Cash-equivalent for a ${
      h !== null ? `${Math.round(h * 12)}-month` : 'short'
    } horizon — no duration risk, daily-liquid via TSX.`;
  }
  if (s.category === 'Balanced') {
    const equity = typeof s.equityPct === 'number' ? s.equityPct : 60;
    return `${equity}/${100 - equity} equity-bond mix, matched to this risk tier.`;
  }
  if (s.category === 'Growth') return '80/20 equity-bond mix, growth tilt with some ballast.';
  if (s.category === 'AllEquity') {
    return `All-equity single-ticker diversification at ${((s.mer ?? 0) * 100 || 0).toFixed(2)}% MER.`;
  }
  if (s.category === 'DividendUS') {
    return 'US dividend payer — best in RRSP via the Canada-US treaty exemption from withholding.';
  }
  if (s.category === 'DividendCanadian') {
    return 'Canadian eligible dividend ETF — tax-credit-friendly in non-registered, fully sheltered in TFSA.';
  }
  if (s.category === 'IntermediateBond' || s.category === 'ShortTermBond') {
    return `Bond ballast — duration ${s.durationYears ?? '?'}yr at ${(
      (s.mer ?? 0) * 100 || 0
    ).toFixed(2)}% MER.`;
  }
  if (s.category === 'IndividualStock') {
    return `Single-name pick — ${s.description}`;
  }
  if (s.category === 'LeveragedETF') {
    return `Leveraged ETF — daily-reset compounding; size small and shelter the volatility.`;
  }
  if (s.category === 'SectorEquity') {
    return `Concentrated sector exposure — ${s.description}`;
  }
  if (s.category === 'CryptoAdjacent') {
    return `Crypto-adjacent — high volatility, no yield; capital-gains-shaped.`;
  }
  if (s.category === 'REIT') {
    return `REIT — distributions are most efficient in an RRSP (US REITs get the treaty exemption from withholding).`;
  }
  if (s.category === 'Speculative') {
    return `Speculative growth ETF — TFSA shelters both the volatility and any windfall gain.`;
  }
  if (s.category === 'CoveredCall') {
    if (s.navErosionRisk === 'high') {
      return 'High-distribution covered-call/credit product. NAV-erosion risk: distributions may be partly return-of-capital. Size as a satellite.';
    }
    if (s.navErosionRisk === 'moderate') {
      return 'Covered-call / high-yield income. Earns option premium or credit spread; some NAV-erosion risk.';
    }
    return 'Sustainable covered-call income. Spread-based, earns the option premium rather than bleeding NAV.';
  }
  return s.description;
}

export function computeProgress(
  goal: GoalInput,
  positions: readonly LinkedPosition[],
  usdToCad: number,
  now: Date = new Date(),
): GoalProgress {
  let currentCad = 0;
  for (const p of positions) {
    const close = p.latestClose ?? 0;
    const native = p.shares * close * p.allocation;
    const cad = p.currency === 'USD' ? native * usdToCad : native;
    currentCad += cad;
  }
  const target = goal.targetAmountCad;
  const pct = target > 0 ? Math.min(100, (currentCad / target) * 100) : 0;
  const shortfall = target - currentCad;
  const monthsRemaining = goal.targetDate
    ? Math.max(0, Math.round((goal.targetDate.getTime() - now.getTime()) / MS_PER_MONTH))
    : null;
  const requiredMonthly =
    monthsRemaining !== null && monthsRemaining > 0 && shortfall > 0
      ? shortfall / monthsRemaining
      : null;
  // On-track = actual % vs the expected linear progress over the goal's real
  // created→target window (10% grace). Open-ended goals (no targetDate) have no
  // deadline to fall behind, so onTrack is always true. createdAt defaults to
  // now when absent — yields expectedPct=0 → trivially on track — so callers
  // that don't supply it never get a false "behind" signal.
  let onTrack = true;
  if (goal.targetDate) {
    const createdAt = goal.createdAt ?? now;
    const total = goal.targetDate.getTime() - createdAt.getTime();
    let expectedPct: number;
    if (total <= 0) {
      // createdAt at or past targetDate — the full horizon has elapsed.
      expectedPct = 100;
    } else {
      const elapsed = now.getTime() - createdAt.getTime();
      expectedPct = Math.max(0, Math.min(1, elapsed / total)) * 100;
    }
    onTrack = pct >= expectedPct * 0.9;
  }

  return {
    currentValueCad: currentCad,
    targetCad: target,
    percentComplete: pct,
    shortfallCad: shortfall,
    monthsRemaining,
    requiredMonthlyCad: requiredMonthly,
    onTrack,
  };
}

export function detectConflicts(
  goals: readonly GoalInput[],
  positions: readonly LinkedPosition[],
  accounts: readonly AccountSummary[],
  now: Date = new Date(),
): GoalConflict[] {
  const out: GoalConflict[] = [];

  // 1. allocation-overflow per position. The caller passes a flat list of
  // links; each LinkedPosition carries its owning goalId, so group by
  // positionId, sum allocation, and attribute the contributing goals.
  const goalIdSet = new Set(goals.map((g) => g.id));
  const allocByPosition = new Map<number, { total: number; goalIds: Set<number> }>();
  for (const p of positions) {
    const entry = allocByPosition.get(p.positionId) ?? { total: 0, goalIds: new Set<number>() };
    entry.total += p.allocation;
    if (p.goalId !== undefined && goalIdSet.has(p.goalId)) entry.goalIds.add(p.goalId);
    allocByPosition.set(p.positionId, entry);
  }
  for (const [positionId, { total, goalIds }] of allocByPosition) {
    if (total > 1.0 + 1e-6) {
      out.push({
        kind: 'allocation-overflow',
        goalIds: [...goalIds],
        message: `Position ${positionId} is allocated ${(total * 100).toFixed(0)}% across goals — exceeds 100%.`,
      });
    }
  }

  // 2. account-room-shortfall: sum of shortfall across goals sharing the same
  // recommended account type (explicit accountId takes precedence).
  const byType = new Map<string, { ids: number[]; shortfall: number }>();
  for (const goal of goals) {
    if (goal.archivedAt) continue;
    const explicit =
      goal.accountId == null
        ? null
        : (accounts.find((a) => a.id === goal.accountId && !a.archived) ?? null);

    const recAccount = recommendAccount(goal, accounts, now);
    const recommended =
      recAccount.bestAccountId == null
        ? null
        : (accounts.find((a) => a.id === recAccount.bestAccountId && !a.archived) ?? null);
    const top = explicit?.type ?? recommended?.type ?? recAccount.rankedTypes[0];
    if (!top) continue;
    const currentValueCad = goal.currentValueCad ?? 0;
    const shortfall = Math.max(goal.targetAmountCad - currentValueCad, 0);
    if (shortfall <= 0) continue;

    const entry = byType.get(top) ?? { ids: [], shortfall: 0 };
    entry.ids.push(goal.id);
    entry.shortfall += shortfall;
    byType.set(top, entry);
  }
  for (const [type, { ids, shortfall }] of byType) {
    if (ids.length < 2) continue;
    const room = accounts
      .filter((a) => a.type === type && !a.archived)
      .reduce((s, a) => s + (a.contributionRoomCad ?? 0), 0);
    if (room > 0 && shortfall > room) {
      out.push({
        kind: 'account-room-shortfall',
        goalIds: ids,
        message: `Goals targeting ${type} shortfall ($${shortfall.toLocaleString()}) exceeds available room ($${room.toLocaleString()}).`,
      });
    }
  }

  // 3. horizon-mismatch: short-horizon goal funded by USD exposure
  const hasGoalScopedLinks = positions.some((p) => p.goalId !== undefined);
  for (const goal of goals) {
    if (goal.archivedAt) continue;
    const h = horizonYears(goal, now);
    if (h === null || h >= 2) continue;
    if (
      !(
        ['Withdrawal', 'DownPayment', 'Vacation', 'TaxBill', 'EmergencyFund'] as GoalType[]
      ).includes(goal.type)
    )
      continue;
    const linkedPositions = hasGoalScopedLinks
      ? positions.filter((p) => p.goalId === goal.id)
      : positions;
    if (linkedPositions.length === 0) continue;
    const risky = linkedPositions.find((p) => p.currency === 'USD' || p.listingCountry === 'US');
    if (risky) {
      out.push({
        kind: 'horizon-mismatch',
        goalIds: [goal.id],
        message: `Short-horizon goal (${Math.round(h * 12)}mo) is linked to ${risky.ticker}. Consider cash-equivalent ETFs if this is a pre-dated spending goal.`,
      });
    }
  }

  // 4. risk-horizon-override: an explicit override is being honored on a
  // near-dated goal the horizon would otherwise de-risk. Honest warning that
  // the user is accepting real swing risk on money they may need soon.
  for (const goal of goals) {
    if (goal.archivedAt) continue;
    const warning = riskHorizonOverrideWarning(goal, now);
    if (warning) out.push(warning);
  }

  return out;
}

export function glideAllocation(goal: GoalInput, now: Date = new Date()): GlideAllocation {
  let risk = deriveRiskTolerance(goal, now);
  const h = horizonYears(goal, now);
  // Short-horizon capital-preservation clamp. Explicit override wins: only
  // force VeryLow when the risk is horizon-derived. EmergencyFund is the
  // carve-out — it stays cash-locked even with an explicit override (so its
  // allocation matches its definitional cash-only categories).
  if (h !== null && h < 2 && (goal.riskOverride == null || goal.type === 'EmergencyFund')) {
    risk = 'VeryLow';
  }

  switch (risk) {
    case 'VeryLow':
      return { cashPct: 100, bondPct: 0, equityPct: 0 };
    case 'Low':
      return { cashPct: 20, bondPct: 60, equityPct: 20 };
    case 'Moderate':
      return { cashPct: 5, bondPct: 35, equityPct: 60 };
    case 'High':
      return { cashPct: 0, bondPct: 20, equityPct: 80 };
    case 'Aggressive':
      return { cashPct: 0, bondPct: 0, equityPct: 100 };
  }
}

// Risk tiers low→high — used to compare an explicit override against what the
// horizon alone would derive (so the warning only fires when the user dialled
// risk materially UP, not down).
const RISK_ORDER: readonly RiskTolerance[] = ['VeryLow', 'Low', 'Moderate', 'High', 'Aggressive'];

function riskRank(r: RiskTolerance): number {
  return RISK_ORDER.indexOf(r);
}

/**
 * Risk-vs-horizon warning for a goal whose explicit `riskOverride` is being
 * honored over the horizon-based de-risking. Returns null when no warning is
 * warranted (no override, no de-risking would have applied, override not
 * materially above the horizon-derived risk, or EmergencyFund — which stays
 * cash-locked and so carries no swing risk to warn about).
 *
 * The principle: horizon is the smart default, but an explicit override is a
 * conscious signal we honor — with an honest warning when it puts volatile
 * holdings against money the user may need soon.
 */
export function riskHorizonOverrideWarning(
  goal: GoalInput,
  now: Date = new Date(),
): GoalConflict | null {
  if (goal.riskOverride == null) return null;
  // EmergencyFund stays cash-locked regardless of override — no swing risk.
  if (goal.type === 'EmergencyFund') return null;

  const h = horizonYears(goal, now);
  // Only goals the horizon would otherwise de-risk: a real, near-dated target.
  if (h === null || h >= 3) return null;

  // The override must be materially above what the horizon alone would derive
  // (≥ 2 tiers up, e.g. VeryLow→Moderate or Low→Aggressive) — otherwise honoring
  // it isn't a notable risk-vs-horizon mismatch worth flagging.
  const horizonRisk = deriveRiskTolerance({ ...goal, riskOverride: null }, now);
  if (riskRank(goal.riskOverride) - riskRank(horizonRisk) < 2) return null;

  const months = Math.max(0, Math.round(h * 12));
  return {
    kind: 'risk-horizon-override',
    goalIds: [goal.id],
    message:
      `You've set ${goal.riskOverride} on a ${months}-month ${goal.type} goal. ` +
      `These holdings can swing 20–30%+ before your target date — that's the ` +
      `risk you're accepting with money you may need soon.`,
  };
}

// Helper to integrate with existing placement engine — useful when caller has
// a per-position stock profile and wants the engine to incorporate tax-aware
// account selection.
export function placementForLinkedPosition(
  position: LinkedPosition,
  accounts: readonly AccountSummary[],
) {
  return decidePlacement(
    {
      ticker: position.ticker,
      listingCountry: position.listingCountry ?? (position.currency === 'USD' ? 'US' : 'CA'),
      dividendYieldTtm: null,
      growth5y: null,
      beta: null,
      isSpeculative: false,
      marketCapUsd: null,
    },
    accounts,
  );
}
