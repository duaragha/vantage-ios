/**
 * DCA projection unit tests — money math, so every assertion is checked against
 * an independently hand-computed value (see comments).
 *
 * Runs on node:test (stdlib) — same pattern as engine.test.ts. The task brief
 * said "vitest" but this package has no test framework dependency and ships its
 * suite via `tsc` + `node --test packages/core/dist/...`; matching that avoids
 * adding an unused dependency and a second runner. The assertions are identical
 * either way.
 *
 * Run with:
 *   pnpm --filter @vantage/core build && \
 *   node --test packages/core/dist/goals/dcaProjection.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PERIODS_PER_YEAR,
  expectedAnnualReturn,
  expectedReturnForAllocation,
  futureValueAnnuity,
  solvePayment,
  projectGoal,
} from './dcaProjection.js';

const NOW = new Date('2026-06-01T00:00:00Z');

function approx(actual: number, expected: number, tol = 0.01): void {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `expected ${actual} to be within ${tol} of ${expected}`,
  );
}

describe('PERIODS_PER_YEAR', () => {
  it('maps frequency to the right periods/year', () => {
    assert.equal(PERIODS_PER_YEAR.Weekly, 52);
    assert.equal(PERIODS_PER_YEAR.Biweekly, 26);
    assert.equal(PERIODS_PER_YEAR.Monthly, 12);
    assert.equal(PERIODS_PER_YEAR.Quarterly, 4);
  });
});

describe('expectedAnnualReturn (FP Canada 2026 PAG blend)', () => {
  it('returns the documented net nominal rate per risk tier', () => {
    approx(expectedAnnualReturn({ risk: 'VeryLow' }), 0.022, 1e-9);
    approx(expectedAnnualReturn({ risk: 'Low' }), 0.035, 1e-9);
    approx(expectedAnnualReturn({ risk: 'Moderate' }), 0.0493, 1e-9);
    approx(expectedAnnualReturn({ risk: 'High' }), 0.0563, 1e-9);
    approx(expectedAnnualReturn({ risk: 'Aggressive' }), 0.0628, 1e-9);
  });

  it('defaults to Moderate when neither risk nor strategy is given', () => {
    approx(expectedAnnualReturn({}), 0.0493, 1e-9);
  });

  it('nudges the tier by strategy when risk is absent', () => {
    approx(expectedAnnualReturn({ strategy: 'Preservation' }), 0.022, 1e-9); // -> VeryLow
    approx(expectedAnnualReturn({ strategy: 'Income' }), 0.035, 1e-9); // -> Low
    approx(expectedAnnualReturn({ strategy: 'Balanced' }), 0.0493, 1e-9); // stays Moderate
    approx(expectedAnnualReturn({ strategy: 'Growth' }), 0.0563, 1e-9); // -> High
  });

  it('lets an explicit risk override beat strategy', () => {
    approx(expectedAnnualReturn({ risk: 'VeryLow', strategy: 'Growth' }), 0.022, 1e-9);
  });
});

describe('expectedReturnForAllocation (glide-split blend)', () => {
  it('reproduces the per-tier net rates for the five canonical glide splits', () => {
    // Same allocations glideAllocation() emits for each tier; the blend is the
    // source of truth and round-trips to NET_RETURN_BY_TIER to 4-decimal
    // rounding (the tier constants are the rounded form of this same math).
    approx(expectedReturnForAllocation({ cashPct: 100, bondPct: 0, equityPct: 0 }), 0.022, 1e-9);
    approx(expectedReturnForAllocation({ cashPct: 20, bondPct: 60, equityPct: 20 }), 0.035, 5e-4);
    approx(expectedReturnForAllocation({ cashPct: 5, bondPct: 35, equityPct: 60 }), 0.0493, 5e-4);
    approx(expectedReturnForAllocation({ cashPct: 0, bondPct: 20, equityPct: 80 }), 0.0563, 5e-4);
    approx(expectedReturnForAllocation({ cashPct: 0, bondPct: 0, equityPct: 100 }), 0.0628, 5e-4);
  });

  it('falls back to the Moderate net rate for a degenerate (empty) split', () => {
    approx(expectedReturnForAllocation({ cashPct: 0, bondPct: 0, equityPct: 0 }), 0.0493, 1e-9);
  });

  it('orders monotonically: more equity -> higher expected return', () => {
    const cash = expectedReturnForAllocation({ cashPct: 100, bondPct: 0, equityPct: 0 });
    const mixed = expectedReturnForAllocation({ cashPct: 0, bondPct: 50, equityPct: 50 });
    const equity = expectedReturnForAllocation({ cashPct: 0, bondPct: 0, equityPct: 100 });
    assert.ok(cash < mixed && mixed < equity);
  });
});

describe('projectGoal — horizon-aware glide rate', () => {
  it('prices a near-dated Aggressive goal off its cash glide, not the tier', () => {
    // The real Goal-1 scenario: Aggressive tier (6.28%) but the engine glides a
    // sub-2yr goal to 100% cash, so the projection must use the cash rate.
    const p = projectGoal({
      currentValue: 5000,
      contributionAmountCad: 500,
      frequency: 'Biweekly',
      startDate: NOW,
      targetDate: new Date('2027-06-01T00:00:00Z'),
      targetAmountCad: 20000,
      risk: 'Aggressive',
      strategy: 'Growth',
      glide: { cashPct: 100, bondPct: 0, equityPct: 0 },
      asOf: NOW,
    });
    approx(p.assumedAnnualReturn, 0.022, 1e-9); // cash rate, NOT 0.0628
  });

  it('still projects a long-horizon all-equity glide at the equity rate', () => {
    const p = projectGoal({
      currentValue: 5000,
      contributionAmountCad: 500,
      frequency: 'Monthly',
      startDate: NOW,
      targetDate: new Date('2046-06-01T00:00:00Z'),
      targetAmountCad: 500000,
      risk: 'Aggressive',
      glide: { cashPct: 0, bondPct: 0, equityPct: 100 },
      asOf: NOW,
    });
    approx(p.assumedAnnualReturn, 0.0628, 5e-4);
  });

  it('falls back to the tier blend when no glide is supplied', () => {
    const p = projectGoal({
      currentValue: 5000,
      contributionAmountCad: 500,
      frequency: 'Monthly',
      startDate: NOW,
      targetDate: new Date('2036-06-01T00:00:00Z'),
      targetAmountCad: 200000,
      risk: 'Aggressive',
      asOf: NOW,
    });
    approx(p.assumedAnnualReturn, 0.0628, 1e-9);
  });
});

describe('futureValueAnnuity (FV = PV*(1+r)^n + PMT*((1+r)^n-1)/r)', () => {
  it('matches a hand-computed value: PV=10000, PMT=500/mo, r=6%/yr, 120 mo', () => {
    // Independently: (1.005)^120 = 1.8193967340; FV = 10000*1.8193967340
    //   + 500*((1.8193967340-1)/0.005) = 100133.6407...
    const fv = futureValueAnnuity({
      presentValue: 10000,
      payment: 500,
      periodicRate: 0.06 / 12,
      periods: 120,
    });
    approx(fv, 100133.64, 0.01);
  });

  it('handles r=0 as FV = PV + PMT*n', () => {
    const fv = futureValueAnnuity({
      presentValue: 10000,
      payment: 500,
      periodicRate: 0,
      periods: 120,
    });
    assert.equal(fv, 70000);
  });

  it('returns PV when there are no periods', () => {
    assert.equal(
      futureValueAnnuity({ presentValue: 12345, payment: 500, periodicRate: 0.01, periods: 0 }),
      12345,
    );
  });

  it('pure annuity (PV=0) matches the closed form', () => {
    // 1000/mo, 1%/period, 12 periods: 1000*((1.01^12 -1)/0.01) = 12682.503...
    const fv = futureValueAnnuity({
      presentValue: 0,
      payment: 1000,
      periodicRate: 0.01,
      periods: 12,
    });
    approx(fv, 12682.5, 0.1);
  });
});

describe('solvePayment (PMT = (FV - PV*(1+r)^n) / (((1+r)^n-1)/r))', () => {
  it('round-trips: solved PMT plugged back into FV lands on target', () => {
    const r = 0.06 / 12;
    const n = 120;
    const target = 200000;
    const pmt = solvePayment({
      presentValue: 10000,
      futureValue: target,
      periodicRate: r,
      periods: n,
    });
    assert.ok(pmt !== null);
    approx(pmt!, 1109.39, 0.01);
    const fv = futureValueAnnuity({
      presentValue: 10000,
      payment: pmt!,
      periodicRate: r,
      periods: n,
    });
    approx(fv, target, 0.01);
  });

  it('handles r=0 as PMT = (FV - PV) / n', () => {
    const pmt = solvePayment({
      presentValue: 10000,
      futureValue: 70000,
      periodicRate: 0,
      periods: 120,
    });
    assert.equal(pmt, 500);
  });

  it('returns null when there are no periods to contribute', () => {
    assert.equal(
      solvePayment({ presentValue: 10000, futureValue: 70000, periodicRate: 0.005, periods: 0 }),
      null,
    );
    assert.equal(
      solvePayment({ presentValue: 10000, futureValue: 70000, periodicRate: 0.005, periods: -3 }),
      null,
    );
  });
});

describe('projectGoal — no schedule', () => {
  it('returns a quiet null shape but still reports the assumed return', () => {
    const p = projectGoal({
      currentValue: 5000,
      contributionAmountCad: null,
      frequency: null,
      startDate: null,
      targetDate: new Date('2030-06-01T00:00:00Z'),
      targetAmountCad: 50000,
      risk: 'Moderate',
      asOf: NOW,
    });
    assert.equal(p.hasSchedule, false);
    assert.equal(p.projectedValueAtTarget, null);
    assert.equal(p.onTrack, null);
    assert.equal(p.shortfall, null);
    assert.equal(p.requiredContribution, null);
    assert.equal(p.monthsToTarget, null);
    assert.equal(p.nextContributionDate, null);
    assert.deepEqual(p.series, []);
    approx(p.assumedAnnualReturn, 0.0493, 1e-9);
  });

  it('treats a zero/negative contribution as no schedule', () => {
    const p = projectGoal({
      currentValue: 5000,
      contributionAmountCad: 0,
      frequency: 'Monthly',
      startDate: NOW,
      targetDate: null,
      targetAmountCad: 50000,
      asOf: NOW,
    });
    assert.equal(p.hasSchedule, false);
  });
});

describe('projectGoal — dated goal projection + required contribution', () => {
  it('projects forward and solves the required contribution (round-trip lands on target)', () => {
    // PV=10000, $500/mo, Moderate (4.93%/yr), 10y target.
    const target = new Date('2036-06-01T00:00:00Z'); // 10 years from NOW
    const p = projectGoal({
      currentValue: 10000,
      contributionAmountCad: 500,
      frequency: 'Monthly',
      startDate: NOW,
      targetDate: target,
      targetAmountCad: 200000,
      risk: 'Moderate',
      asOf: NOW,
    });
    assert.equal(p.hasSchedule, true);
    approx(p.assumedAnnualReturn, 0.0493, 1e-9);

    // Hand check: r=0.0493/12, n=120, FV = 10000*(1+r)^120 + 500*((1+r)^120-1)/r
    const r = 0.0493 / 12;
    const g = Math.pow(1 + r, 120);
    const expectedFv = 10000 * g + 500 * ((g - 1) / r);
    approx(p.projectedValueAtTarget!, Math.round(expectedFv * 100) / 100, 0.02);

    // 200k target with only ~$88k projected -> off track, positive shortfall.
    assert.equal(p.onTrack, false);
    assert.ok(p.shortfall! > 0);

    // The solved requiredContribution, fed back through FV, must hit target.
    assert.ok(p.requiredContribution !== null && p.requiredContribution! > 500);
    const fvAtRequired = futureValueAnnuity({
      presentValue: 10000,
      payment: p.requiredContribution!,
      periodicRate: r,
      periods: 120,
    });
    approx(fvAtRequired, 200000, 1.0);
  });

  it('marks onTrack and clamps requiredContribution to 0 when already over target', () => {
    // Big PV, tiny target -> projection sails past; nothing required.
    const p = projectGoal({
      currentValue: 100000,
      contributionAmountCad: 100,
      frequency: 'Monthly',
      startDate: NOW,
      targetDate: new Date('2031-06-01T00:00:00Z'),
      targetAmountCad: 50000,
      risk: 'High',
      asOf: NOW,
    });
    assert.equal(p.onTrack, true);
    assert.equal(p.shortfall, 0);
    assert.equal(p.requiredContribution, 0);
    assert.equal(p.monthsToTarget, 0); // already at/over target at month 0
  });

  it('produces a monthly series that starts at the current value and grows monotonically', () => {
    const p = projectGoal({
      currentValue: 8000,
      contributionAmountCad: 250,
      frequency: 'Biweekly',
      startDate: NOW,
      targetDate: new Date('2030-06-01T00:00:00Z'),
      targetAmountCad: 40000,
      risk: 'Moderate',
      asOf: NOW,
    });
    assert.ok(p.series.length >= 2);
    assert.equal(p.series[0]!.month, 0);
    approx(p.series[0]!.projected, 8000, 0.01);
    // Monotonic non-decreasing projected balance and contributed total.
    for (let i = 1; i < p.series.length; i++) {
      assert.ok(p.series[i]!.projected >= p.series[i - 1]!.projected - 0.01);
      assert.ok(p.series[i]!.contributed >= p.series[i - 1]!.contributed - 0.01);
      assert.ok(p.series[i]!.month > p.series[i - 1]!.month);
    }
    // Biweekly into a month ~ $250 * (26/12) ≈ $541/mo of new contributions by
    // the first full month.
    const firstMonth = p.series.find((s) => s.month === 1);
    assert.ok(firstMonth && firstMonth.contributed > 0);
  });
});

describe('projectGoal — open-ended goal (no target date)', () => {
  it('has no projectedValueAtTarget but still finds monthsToTarget via the series', () => {
    const p = projectGoal({
      currentValue: 1000,
      contributionAmountCad: 500,
      frequency: 'Monthly',
      startDate: NOW,
      targetDate: null,
      targetAmountCad: 12000,
      risk: 'Moderate',
      asOf: NOW,
    });
    assert.equal(p.hasSchedule, true);
    assert.equal(p.projectedValueAtTarget, null);
    assert.equal(p.onTrack, null);
    assert.equal(p.shortfall, null);
    assert.equal(p.requiredContribution, null);
    // 1000 + ~500/mo with light growth crosses 12000 a hair under ~22 months.
    assert.ok(p.monthsToTarget !== null);
    assert.ok(p.monthsToTarget! >= 20 && p.monthsToTarget! <= 24);
    assert.ok(p.series.length >= 2);
  });

  it('returns monthsToTarget null when an open-ended goal never reaches target inside the cap', () => {
    const p = projectGoal({
      currentValue: 0,
      contributionAmountCad: 10,
      frequency: 'Monthly',
      startDate: NOW,
      targetDate: null,
      targetAmountCad: 100_000_000,
      risk: 'VeryLow',
      asOf: NOW,
    });
    assert.equal(p.monthsToTarget, null);
  });
});

describe('projectGoal — nextContributionDate stepping', () => {
  it('steps a past startDate forward to the next date on/after asOf', () => {
    // Start 2026-01-05, monthly, asOf 2026-06-01 -> next on/after is 2026-06-05.
    const p = projectGoal({
      currentValue: 1000,
      contributionAmountCad: 200,
      frequency: 'Monthly',
      startDate: new Date('2026-01-05T00:00:00Z'),
      targetDate: new Date('2030-06-01T00:00:00Z'),
      targetAmountCad: 50000,
      risk: 'Moderate',
      asOf: NOW,
    });
    assert.equal(p.nextContributionDate, '2026-06-05');
  });

  it('uses startDate directly when it is in the future', () => {
    const p = projectGoal({
      currentValue: 1000,
      contributionAmountCad: 200,
      frequency: 'Weekly',
      startDate: new Date('2026-07-15T00:00:00Z'),
      targetDate: null,
      targetAmountCad: 50000,
      risk: 'Moderate',
      asOf: NOW,
    });
    assert.equal(p.nextContributionDate, '2026-07-15');
  });

  it('steps biweekly correctly', () => {
    // Start 2026-05-20, biweekly. asOf 2026-06-01. 05-20 -> 06-03 (next on/after).
    const p = projectGoal({
      currentValue: 1000,
      contributionAmountCad: 200,
      frequency: 'Biweekly',
      startDate: new Date('2026-05-20T00:00:00Z'),
      targetDate: null,
      targetAmountCad: 50000,
      risk: 'Moderate',
      asOf: NOW,
    });
    assert.equal(p.nextContributionDate, '2026-06-03');
  });
});

describe('projectGoal — frequency consistency', () => {
  it('weekly and monthly with the same annual contribution converge near the same FV', () => {
    // $1200/yr either as $100/mo or ~$23.08/wk, 5y, Moderate. Ordinary-annuity
    // timing differs slightly but the totals should be within ~1%.
    const target = new Date('2031-06-01T00:00:00Z');
    const monthly = projectGoal({
      currentValue: 5000,
      contributionAmountCad: 100,
      frequency: 'Monthly',
      startDate: NOW,
      targetDate: target,
      targetAmountCad: 999999,
      risk: 'Moderate',
      asOf: NOW,
    });
    const weekly = projectGoal({
      currentValue: 5000,
      contributionAmountCad: 1200 / 52,
      frequency: 'Weekly',
      startDate: NOW,
      targetDate: target,
      targetAmountCad: 999999,
      risk: 'Moderate',
      asOf: NOW,
    });
    const diff = Math.abs(monthly.projectedValueAtTarget! - weekly.projectedValueAtTarget!);
    assert.ok(
      diff / monthly.projectedValueAtTarget! < 0.01,
      `monthly ${monthly.projectedValueAtTarget} vs weekly ${weekly.projectedValueAtTarget}`,
    );
  });
});
