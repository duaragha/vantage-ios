// DCA (dollar-cost-averaging) goal projection. Pure functions over a goal's
// current value + contribution schedule; no DB calls. Mirrors the style of
// engine.ts (local string-union types, no @vantage/db import).
//
// A contribution schedule is the missing FORWARD input to goal progress: the
// engine's computeProgress only looks backward (createdAt -> now). Given a
// recurring contribution and an expected return we can project the goal forward
// to its target date and answer: will it land on target, and if not, how much
// more per period is needed?
//
// ---------------------------------------------------------------------------
// EXPECTED RETURN — derivation (real-money software: numbers are not invented)
// ---------------------------------------------------------------------------
// Source: 2026 Projection Assumption Guidelines, jointly published by the
// Institute of Financial Planning and FP Canada Standards Council (April 2026)
// — the Canadian standard planners are expected to use for long-term (10y+)
// projections. Gross NOMINAL return assumptions, before fees:
//     short-term         2.4%
//     fixed income       3.2%
//     Canadian equity    6.3%
//     US equity          6.4%
//     intl developed     6.6%
//     emerging equity    7.5%
//     (inflation 2.1%, borrowing 4.40%)
// The PAG is explicit: "the administrative and investment management fees paid
// by clients both for products and advice must be subtracted to obtain the net
// return." This is a self-directed Wealthsimple ETF portfolio (no advice fee),
// so we subtract a conservative 0.20% all-in product MER (broad-index ETFs like
// VFV/VDY/XEF run 0.05-0.22%).
//
// Per-tier blend uses the SAME cash/bond/equity split the engine already
// assigns each risk tier (glideAllocation in engine.ts), with the equity sleeve
// decomposed into a Canadian-investor global mix (~30% CA / 45% US / 18% intl
// developed / 7% emerging — the design of VEQT/XEQT-style asset-allocation
// ETFs). Equity blend = 6.483% gross. Net nominal by tier (gross - 0.20% fee):
//     VeryLow    100/0/0    -> 2.20%
//     Low        20/60/20   -> 3.50%
//     Moderate   5/35/60    -> 4.93%
//     High       0/20/80    -> 5.63%
//     Aggressive 0/0/100    -> 6.28%
// Risk tier is resolved from the goal's risk override / derived risk (the same
// deriveRiskTolerance signal the rest of the engine uses). Strategy nudges the
// tier when no explicit risk is set (Preservation down, Growth up) so an
// income/preservation goal isn't projected at an all-equity rate.
//
// HORIZON-AWARE RATE: when the caller passes the goal's actual glideAllocation
// (which already de-risks to cash inside ~2yr of the target), projectGoal
// prices the projection off THAT split via expectedReturnForAllocation, not the
// raw tier. This keeps the projected rate consistent with the securities the
// engine actually recommends to hold: a near-dated Aggressive goal glides to
// 100% cash, so it must project at the cash rate (~2.2%), not the all-equity
// 6.28%. A long-horizon Aggressive goal still glides to 100% equity and so
// still projects ~6.28%. The five canonical glide splits reproduce the tier
// rates exactly, so this is a strict generalization of the tier blend.
//
// Per the PAG, planners must "use the projected economic assumptions as a whole
// and avoid attempting to personalize a forecast ... by making a significant
// adjustment to a single variable" — hence the blend is fixed by tier, not
// hand-tuned per goal.

export type ContributionFrequency = 'Weekly' | 'Biweekly' | 'Monthly' | 'Quarterly';

export type RiskTolerance = 'VeryLow' | 'Low' | 'Moderate' | 'High' | 'Aggressive';

export type GoalStrategy = 'Income' | 'Growth' | 'Balanced' | 'Preservation';

export const PERIODS_PER_YEAR: Record<ContributionFrequency, number> = {
  Weekly: 52,
  Biweekly: 26,
  Monthly: 12,
  Quarterly: 4,
};

// Net nominal annual return by risk tier — see file header for the FP Canada
// 2026 PAG derivation. Decimal form (0.0628 = 6.28%).
const NET_RETURN_BY_TIER: Record<RiskTolerance, number> = {
  VeryLow: 0.022,
  Low: 0.035,
  Moderate: 0.0493,
  High: 0.0563,
  Aggressive: 0.0628,
};

// Per-sleeve GROSS nominal returns (FP Canada 2026 PAG) and the all-in product
// fee, in decimal. These are the same inputs the per-tier constants above are
// built from — exposed here so a projection can be priced off a goal's actual
// cash/bond/equity glide split (horizon-aware) rather than the raw risk tier.
// Equity sleeve = Canadian-investor global mix (30% CA 6.3 / 45% US 6.4 /
// 18% intl 6.6 / 7% emerging 7.5) = 6.483% gross. Reproduces NET_RETURN_BY_TIER
// exactly for the five canonical splits (e.g. 0/0/100 -> 6.483 - 0.20 = 6.28%).
const GROSS_CASH = 0.024;
const GROSS_BOND = 0.032;
const GROSS_EQUITY = 0.06483;
const PRODUCT_FEE = 0.002;

const TIER_ORDER: RiskTolerance[] = ['VeryLow', 'Low', 'Moderate', 'High', 'Aggressive'];

export interface GlideMix {
  cashPct: number;
  bondPct: number;
  equityPct: number;
}

/**
 * Net nominal annual return (decimal) for a cash/bond/equity split. Blends the
 * per-sleeve gross PAG rates by weight, then subtracts the product fee — the
 * SAME derivation behind NET_RETURN_BY_TIER, so the canonical tier allocations
 * round-trip to their tier rates. Percentages may be 0..100 (their sum is used
 * as the denominator, so an unnormalized {100,0,0} works). Falls back to the
 * Moderate net rate when the split is empty/degenerate.
 */
export function expectedReturnForAllocation(mix: GlideMix): number {
  const total = mix.cashPct + mix.bondPct + mix.equityPct;
  if (!(total > 0)) return NET_RETURN_BY_TIER.Moderate;
  const gross =
    (mix.cashPct * GROSS_CASH + mix.bondPct * GROSS_BOND + mix.equityPct * GROSS_EQUITY) / total;
  return gross - PRODUCT_FEE;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
// Average month length over a 400-year Gregorian cycle (146097 days / 4800
// months). Used only for monthsToTarget rounding, never for compounding.
const MS_PER_MONTH = (146097 / 4800) * MS_PER_DAY;

function clampTier(idx: number): RiskTolerance {
  return TIER_ORDER[Math.max(0, Math.min(TIER_ORDER.length - 1, idx))]!;
}

/**
 * Blended net nominal annual return (decimal) for a goal. Defaults to Moderate
 * (4.93%) when neither risk nor strategy is supplied. Strategy only shifts the
 * tier when risk is absent so an explicit risk override always wins.
 */
export function expectedAnnualReturn(opts: {
  risk?: RiskTolerance | null;
  strategy?: GoalStrategy | null;
}): number {
  if (opts.risk) return NET_RETURN_BY_TIER[opts.risk];

  // No explicit risk — start from Moderate and let strategy nudge the tier so a
  // Preservation goal isn't projected at the same rate as a Growth goal.
  let idx = TIER_ORDER.indexOf('Moderate');
  switch (opts.strategy) {
    case 'Preservation':
      idx -= 2; // -> VeryLow
      break;
    case 'Income':
      idx -= 1; // -> Low
      break;
    case 'Growth':
      idx += 1; // -> High
      break;
    case 'Balanced':
    case null:
    case undefined:
    default:
      break;
  }
  return NET_RETURN_BY_TIER[clampTier(idx)];
}

export interface DcaProjection {
  hasSchedule: boolean;
  /** Projected portfolio value at the target date. null when open-ended (no targetDate). */
  projectedValueAtTarget: number | null;
  /** projected >= target? null when there's no target date to evaluate against. */
  onTrack: boolean | null;
  /** max(0, target - projected). null when open-ended. */
  shortfall: number | null;
  /** PMT (per period, in the goal's frequency) needed to exactly hit target by the date. null when not solvable. */
  requiredContribution: number | null;
  /** Months until the projected path first reaches the target (open-ended or dated). null if it never does / no schedule. */
  monthsToTarget: number | null;
  /** Forward monthly path for charting (sub-monthly contributions aggregated into their month). */
  series: Array<{ month: number; date: string; contributed: number; projected: number }>;
  /** Next scheduled contribution date on/after asOf (ISO yyyy-mm-dd). null when no schedule. */
  nextContributionDate: string | null;
  /** The blended net nominal annual return used for this projection (decimal). */
  assumedAnnualReturn: number;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Step a date forward by one contribution period. Pure; returns a new Date. */
function stepDate(from: Date, frequency: ContributionFrequency): Date {
  const d = new Date(from.getTime());
  switch (frequency) {
    case 'Weekly':
      d.setUTCDate(d.getUTCDate() + 7);
      break;
    case 'Biweekly':
      d.setUTCDate(d.getUTCDate() + 14);
      break;
    case 'Monthly':
      d.setUTCMonth(d.getUTCMonth() + 1);
      break;
    case 'Quarterly':
      d.setUTCMonth(d.getUTCMonth() + 3);
      break;
  }
  return d;
}

/**
 * Next contribution date on or after `asOf`, stepping from `startDate` by
 * `frequency`. If startDate is in the future it's the next date as-is.
 * Bounded iteration so a tiny frequency + far-future asOf can't spin forever.
 */
function computeNextContributionDate(
  startDate: Date,
  frequency: ContributionFrequency,
  asOf: Date,
): Date {
  if (startDate.getTime() >= asOf.getTime()) return startDate;
  let d = startDate;
  // Cap iterations generously (weekly over ~200y) — defensive only.
  for (let i = 0; i < 52 * 200; i++) {
    if (d.getTime() >= asOf.getTime()) return d;
    d = stepDate(d, frequency);
  }
  return d;
}

/**
 * Future value of the current balance plus a stream of equal end-of-period
 * (ordinary annuity) contributions, compounded at the periodic rate.
 *
 *   FV = PV*(1+r)^n + PMT*((1+r)^n - 1)/r           (r != 0)
 *   FV = PV + PMT*n                                  (r == 0)
 *
 * r = periodic rate (annual / periodsPerYear), n = number of periods.
 * Ordinary annuity (contribution at period END) is the conservative choice and
 * matches how a real recurring buy lands after each period's growth.
 */
export function futureValueAnnuity(opts: {
  presentValue: number;
  payment: number;
  periodicRate: number;
  periods: number;
}): number {
  const { presentValue: pv, payment: pmt, periodicRate: r, periods: n } = opts;
  if (n <= 0) return pv;
  if (r === 0) return pv + pmt * n;
  const growth = Math.pow(1 + r, n);
  return pv * growth + pmt * ((growth - 1) / r);
}

/**
 * Solve the ordinary-annuity equation for the per-period PMT that lands exactly
 * on `futureValue` after `periods` at `periodicRate`, starting from `pv`:
 *
 *   PMT = (FV - PV*(1+r)^n) / (((1+r)^n - 1)/r)      (r != 0)
 *   PMT = (FV - PV) / n                               (r == 0)
 *
 * Returns null when n <= 0 (no time to contribute). May return <= 0 when the
 * present value already grows past the target unaided — the caller decides what
 * a non-positive required contribution means.
 */
export function solvePayment(opts: {
  presentValue: number;
  futureValue: number;
  periodicRate: number;
  periods: number;
}): number | null {
  const { presentValue: pv, futureValue: fv, periodicRate: r, periods: n } = opts;
  if (n <= 0) return null;
  if (r === 0) return (fv - pv) / n;
  const growth = Math.pow(1 + r, n);
  const annuityFactor = (growth - 1) / r;
  if (annuityFactor === 0) return null; // unreachable for r != 0, n > 0; guard anyway
  return (fv - pv * growth) / annuityFactor;
}

export function projectGoal(opts: {
  currentValue: number;
  contributionAmountCad: number | null;
  frequency: ContributionFrequency | null;
  startDate: Date | null;
  targetDate: Date | null;
  targetAmountCad: number;
  risk?: RiskTolerance | null;
  strategy?: GoalStrategy | null;
  /**
   * The goal's actual cash/bond/equity glide split. When supplied it drives the
   * expected return (horizon-aware), so a near-dated goal that the engine glides
   * to cash projects at the cash-weighted rate — matching what it's told to
   * hold — instead of its raw risk tier's all-equity rate. Falls back to the
   * tier/strategy blend when omitted.
   */
  glide?: GlideMix | null;
  asOf: Date;
}): DcaProjection {
  const annualReturn = opts.glide
    ? expectedReturnForAllocation(opts.glide)
    : expectedAnnualReturn({
        risk: opts.risk ?? null,
        strategy: opts.strategy ?? null,
      });

  const hasSchedule =
    opts.contributionAmountCad != null && opts.contributionAmountCad > 0 && opts.frequency != null;

  // No schedule: nothing to project forward. Return a quiet, fully-null shape
  // (still report the rate we WOULD use, so the UI can explain the assumption).
  if (!hasSchedule) {
    return {
      hasSchedule: false,
      projectedValueAtTarget: null,
      onTrack: null,
      shortfall: null,
      requiredContribution: null,
      monthsToTarget: null,
      series: [],
      nextContributionDate: null,
      assumedAnnualReturn: annualReturn,
    };
  }

  const amount = opts.contributionAmountCad as number;
  const frequency = opts.frequency as ContributionFrequency;
  const periodsPerYear = PERIODS_PER_YEAR[frequency];
  const periodicRate = annualReturn / periodsPerYear;
  // Effective per-period growth from the annual rate; equivalent to the
  // periodic-rate compounding used by futureValueAnnuity.
  const start = opts.startDate ?? opts.asOf;

  const nextContributionDate = isoDate(computeNextContributionDate(start, frequency, opts.asOf));

  // ---- Forward simulation (period-by-period), bucketed into months. --------
  // We walk contribution periods from asOf to the horizon, applying the
  // periodic rate each period and crediting the contribution at period end
  // (ordinary annuity). Each period's resulting balance is attributed to the
  // calendar month it falls in, so the monthly `series` is the right shape for
  // charting regardless of frequency.
  //
  // Horizon: target date when present; otherwise far enough to see the path
  // cross the target (capped) for the open-ended monthsToTarget signal.
  const monthsToHorizon =
    opts.targetDate != null
      ? Math.max(0, Math.ceil((opts.targetDate.getTime() - opts.asOf.getTime()) / MS_PER_MONTH))
      : 600; // 50y cap for open-ended goals
  const maxPeriods = Math.max(
    0,
    Math.ceil((monthsToHorizon / 12) * periodsPerYear) + periodsPerYear,
  );

  // First contribution credited by the simulation. Ordinary-annuity model:
  // contributions land at PERIOD END, i.e. strictly after asOf. A contribution
  // dated exactly at asOf ("today") is the boundary and already reflected in
  // currentValue, so the projection's first new contribution is the next
  // scheduled date strictly after asOf. This keeps the series aligned with the
  // closed-form FV (same period count) — important for money math.
  let firstContribDate = computeNextContributionDate(start, frequency, opts.asOf);
  if (firstContribDate.getTime() <= opts.asOf.getTime()) {
    firstContribDate = stepDate(firstContribDate, frequency);
  }

  const series: Array<{ month: number; date: string; contributed: number; projected: number }> = [];
  // month 0 = today's snapshot, no new contribution yet.
  series.push({
    month: 0,
    date: isoDate(opts.asOf),
    contributed: 0,
    projected: round2(opts.currentValue),
  });

  let balance = opts.currentValue;
  let cumulativeContributed = 0;
  let contribDate = firstContribDate;
  let monthsToTarget: number | null = null;
  const target = opts.targetAmountCad;
  if (balance >= target && target > 0) monthsToTarget = 0;

  // Track which month each period lands in so we snapshot once per month.
  let lastSnapshotMonth = 0;

  for (let period = 1; period <= maxPeriods; period++) {
    // Grow for one period, then contribute at period end.
    balance = balance * (1 + periodicRate) + amount;
    cumulativeContributed += amount;

    const monthIndex = Math.max(
      1,
      Math.round((contribDate.getTime() - opts.asOf.getTime()) / MS_PER_MONTH),
    );

    if (monthsToTarget === null && target > 0 && balance >= target) {
      monthsToTarget = monthIndex;
    }

    // Snapshot at most once per calendar month (use the latest balance in that
    // month). Overwrite if we already pushed this month from an earlier period.
    if (monthIndex > lastSnapshotMonth) {
      series.push({
        month: monthIndex,
        date: isoDate(contribDate),
        contributed: round2(cumulativeContributed),
        projected: round2(balance),
      });
      lastSnapshotMonth = monthIndex;
    } else if (series.length > 0 && series[series.length - 1]!.month === monthIndex) {
      const last = series[series.length - 1]!;
      last.contributed = round2(cumulativeContributed);
      last.projected = round2(balance);
      last.date = isoDate(contribDate);
    }

    // Stop the dated series at the horizon month; open-ended stops once it
    // crosses the target (plus a small tail) or hits the cap.
    if (opts.targetDate != null && monthIndex >= monthsToHorizon) break;
    if (opts.targetDate == null && monthsToTarget !== null && monthIndex >= monthsToTarget) break;

    contribDate = stepDate(contribDate, frequency);
  }

  // ---- Closed-form projection at the target date (authoritative number). ----
  // The series is for charting; the headline projectedValueAtTarget uses the
  // exact annuity formula so it isn't sensitive to monthly bucketing.
  let projectedValueAtTarget: number | null = null;
  let onTrack: boolean | null = null;
  let shortfall: number | null = null;
  let requiredContribution: number | null = null;

  if (opts.targetDate != null) {
    const years = (opts.targetDate.getTime() - opts.asOf.getTime()) / (365.25 * MS_PER_DAY);
    const n = Math.max(0, Math.round(years * periodsPerYear));
    const fv = futureValueAnnuity({
      presentValue: opts.currentValue,
      payment: amount,
      periodicRate,
      periods: n,
    });
    projectedValueAtTarget = round2(fv);
    onTrack = fv >= target;
    shortfall = round2(Math.max(0, target - fv));

    const solved = solvePayment({
      presentValue: opts.currentValue,
      futureValue: target,
      periodicRate,
      periods: n,
    });
    // A non-positive solved PMT means the current balance already reaches the
    // target with no contributions — clamp to 0 ("nothing required").
    requiredContribution = solved == null ? null : round2(Math.max(0, solved));
  }

  return {
    hasSchedule: true,
    projectedValueAtTarget,
    onTrack,
    shortfall,
    requiredContribution,
    monthsToTarget,
    series,
    nextContributionDate,
    assumedAnnualReturn: annualReturn,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
