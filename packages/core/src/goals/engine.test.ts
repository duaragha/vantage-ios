/**
 * Goals engine unit tests — focused on the risk-tolerance contract.
 *
 * Runs on node:test (stdlib) — same pattern as accounts/placement.test.ts.
 *
 * Run with:
 *   pnpm --filter @vantage/core build && \
 *   node --test packages/core/dist/goals/engine.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  recommendSecurities,
  recommendAccount,
  deriveRiskTolerance,
  computeProgress,
  glideAllocation,
  detectConflicts,
  riskHorizonOverrideWarning,
  type GoalInput,
  type GoalStrategy,
  type GoalType,
  type LinkedPosition,
  type RiskTolerance,
} from './engine.js';
import type { DiscoveryPick } from './loaders.js';
import {
  GOAL_INCOME_RISK_KEYS,
  INCOME_RISK_PROFILES,
  MONTHLY_INCOME_TICKERS,
} from './monthlyIncome.js';
import type { AccountSummary } from '../accounts/placement.js';

const NOW = new Date('2026-05-22T00:00:00Z');

function daysFromNow(days: number): Date {
  return new Date(NOW.getTime() + days * 24 * 3600 * 1000);
}

function yearsFromNow(years: number): Date {
  return daysFromNow(years * 365.25);
}

function goal(overrides: Partial<GoalInput> & { type: GoalType }): GoalInput {
  return {
    id: 1,
    name: 'Test',
    targetAmountCad: 100_000,
    targetDate: null,
    isWithdrawal: false,
    riskOverride: null,
    accountId: null,
    ...overrides,
  };
}

function account(
  overrides: Partial<AccountSummary> & { id: number; type: AccountSummary['type'] },
): AccountSummary {
  return {
    currency: 'CAD',
    contributionRoomCad: null,
    currentValueCad: 0,
    archived: false,
    ...overrides,
  };
}

/** Pull category set out of a recommendSecurities result for comparison. */
function categoriesOf(g: GoalInput): string[] {
  const recs = recommendSecurities(g, { limit: 20 }, NOW);
  const cats = new Set<string>();
  for (const r of recs) cats.add(r.security.category);
  return [...cats].sort();
}

function tickersOf(g: GoalInput, limit = 20): string[] {
  return recommendSecurities(g, { limit }, NOW).map((r) => r.security.ticker);
}

describe('categoriesForGoal — risk slider responsiveness', () => {
  it('Withdrawal with 5yr horizon: VeryLow vs Aggressive yield different category sets', () => {
    const base = { type: 'Withdrawal' as const, targetDate: yearsFromNow(5) };
    const veryLow = categoriesOf(goal({ ...base, riskOverride: 'VeryLow' }));
    const aggressive = categoriesOf(goal({ ...base, riskOverride: 'Aggressive' }));

    assert.notDeepEqual(
      veryLow,
      aggressive,
      `expected different palettes, got VeryLow=${veryLow} Aggressive=${aggressive}`,
    );
    // VeryLow must be cash-heavy
    assert.ok(veryLow.includes('CashEquivalent'), 'VeryLow withdrawal must include cash');
    assert.ok(!veryLow.includes('AllEquity'), 'VeryLow withdrawal must NOT include AllEquity');
    // Aggressive (5yr Withdrawal > 3yr) gets the full risk palette
    assert.ok(
      aggressive.some((c) =>
        ['AllEquity', 'EquityUS', 'EquityInternational', 'Growth'].includes(c),
      ),
      `Aggressive 5yr withdrawal must include some growth equity; got ${aggressive}`,
    );
  });

  it('Withdrawal 2yr (1-3yr band), NO override: horizon strips pure equity', () => {
    // Horizon-derived risk path (riskOverride=null) is unchanged: the 1-3yr
    // withdrawal-class strip still removes pure equity.
    const aggressive = categoriesOf(
      goal({ type: 'Withdrawal', targetDate: yearsFromNow(2), riskOverride: null }),
    );
    const pureEquity = ['AllEquity', 'EquityUS', 'EquityInternational', 'EquityEmerging', 'Growth'];
    for (const c of pureEquity) {
      assert.ok(
        !aggressive.includes(c),
        `2yr withdrawal (no override) must strip ${c}, got ${aggressive}`,
      );
    }
    assert.ok(aggressive.length > 0, 'palette must not be empty');
  });

  it('Withdrawal 2yr (1-3yr band), explicit Aggressive override: equity is HONORED', () => {
    // Explicit override wins over the horizon strip — the user gets their full
    // Aggressive palette, including pure equity, despite the short horizon.
    const aggressive = categoriesOf(
      goal({ type: 'Withdrawal', targetDate: yearsFromNow(2), riskOverride: 'Aggressive' }),
    );
    assert.ok(
      aggressive.some((c) =>
        ['AllEquity', 'EquityUS', 'EquityInternational', 'Growth'].includes(c),
      ),
      `explicit Aggressive on a 2yr withdrawal must include pure equity; got ${aggressive}`,
    );
  });

  it('Retirement: VeryLow → cash-only, Aggressive → equity-only', () => {
    const veryLow = categoriesOf(
      goal({ type: 'Retirement', targetDate: yearsFromNow(25), riskOverride: 'VeryLow' }),
    );
    const aggressive = categoriesOf(
      goal({ type: 'Retirement', targetDate: yearsFromNow(25), riskOverride: 'Aggressive' }),
    );
    assert.ok(veryLow.includes('CashEquivalent'), 'VeryLow retirement → cash');
    assert.ok(!veryLow.includes('AllEquity'), 'VeryLow retirement must NOT include AllEquity');
    assert.ok(
      aggressive.some((c) =>
        ['AllEquity', 'EquityUS', 'EquityInternational', 'Growth'].includes(c),
      ),
      `Aggressive retirement must include equity; got ${aggressive}`,
    );
    assert.ok(
      !aggressive.includes('CashEquivalent'),
      `Aggressive retirement must NOT recommend cash; got ${aggressive}`,
    );
  });

  it('Income: VeryLow returns cash while Aggressive returns high-risk monthly income', () => {
    const veryLow = categoriesOf(goal({ type: 'Income', riskOverride: 'VeryLow' }));
    const aggressive = categoriesOf(goal({ type: 'Income', riskOverride: 'Aggressive' }));

    // VeryLow income → cash + (ShortTermBond if present in pool)
    assert.ok(veryLow.includes('CashEquivalent'), `VeryLow Income → cash; got ${veryLow}`);
    assert.ok(!veryLow.includes('AllEquity'), 'VeryLow Income must NOT include AllEquity');
    assert.ok(!veryLow.includes('DividendUS'), 'VeryLow Income must NOT include DividendUS');

    // Aggressive income uses monthly equity-income categories, not cash.
    assert.ok(
      aggressive.some((category) =>
        ['CoveredCall', 'DividendCanadian', 'DividendUS', 'REIT'].includes(category),
      ),
      `Aggressive Income must include a monthly equity-income category; got ${aggressive}`,
    );
    assert.ok(
      !aggressive.includes('CashEquivalent'),
      `Aggressive Income must NOT include cash; got ${aggressive}`,
    );
  });

  it('EmergencyFund: every risk tier returns cash-only', () => {
    const risks: RiskTolerance[] = ['VeryLow', 'Low', 'Moderate', 'High', 'Aggressive'];
    for (const r of risks) {
      const cats = categoriesOf(goal({ type: 'EmergencyFund', riskOverride: r }));
      assert.deepEqual(
        cats,
        ['CashEquivalent'],
        `EmergencyFund at risk=${r} must be cash-only, got ${cats}`,
      );
    }
  });

  it('Sub-1yr Withdrawal, NO override: cash-only (horizon hard cap holds)', () => {
    // riskOverride=null → horizon-derived risk. The sub-1yr hard cap is intact
    // for the horizon-driven path, so the palette is cash regardless of nothing
    // having been dialled up.
    const cats = categoriesOf(
      goal({ type: 'Withdrawal', targetDate: daysFromNow(180), riskOverride: null }),
    );
    assert.deepEqual(
      cats,
      ['CashEquivalent'],
      `Sub-1yr Withdrawal (no override) must be cash-only, got ${cats}`,
    );
  });

  it('Sub-1yr Withdrawal, explicit override: risk is HONORED (not silently cashed)', () => {
    // Explicit override wins over the sub-1yr hard cap. The user's chosen risk
    // tier drives the palette — VeryLow/Low stay safe, but Moderate+ surface
    // their growth/equity shapes instead of being neutralized to cash.
    const aggressive = categoriesOf(
      goal({ type: 'Withdrawal', targetDate: daysFromNow(180), riskOverride: 'Aggressive' }),
    );
    assert.notDeepEqual(
      aggressive,
      ['CashEquivalent'],
      `explicit Aggressive on a sub-1yr Withdrawal must NOT be silently cashed; got ${aggressive}`,
    );
    assert.ok(
      aggressive.some((c) =>
        ['AllEquity', 'EquityUS', 'EquityInternational', 'Growth', 'CoveredCall'].includes(c),
      ),
      `explicit Aggressive sub-1yr Withdrawal must surface risk-appropriate equity/yield; got ${aggressive}`,
    );
    // VeryLow explicit override is still cash (palette itself is cash at VeryLow).
    const veryLow = categoriesOf(
      goal({ type: 'Withdrawal', targetDate: daysFromNow(180), riskOverride: 'VeryLow' }),
    );
    assert.ok(
      veryLow.includes('CashEquivalent'),
      `VeryLow override sub-1yr stays cash-y; got ${veryLow}`,
    );
  });

  it('Education sub-2yr, NO override: cash; multi-year respects risk', () => {
    // Horizon-derived path unchanged: sub-2yr Education de-risks to cash.
    const sub = categoriesOf(
      goal({ type: 'Education', targetDate: yearsFromNow(1), riskOverride: null }),
    );
    assert.ok(
      sub.includes('CashEquivalent'),
      `sub-2yr Education (no override) must be cash; got ${sub}`,
    );
    assert.ok(
      !sub.includes('AllEquity'),
      'sub-2yr Education (no override) must NOT include AllEquity',
    );

    const long = categoriesOf(
      goal({ type: 'Education', targetDate: yearsFromNow(10), riskOverride: 'Aggressive' }),
    );
    // EquityEmerging is filtered for Education at any horizon
    assert.ok(!long.includes('EquityEmerging'), `Education must strip EquityEmerging; got ${long}`);
    assert.ok(
      long.some((c) => ['AllEquity', 'EquityUS', 'EquityInternational', 'Growth'].includes(c)),
      `long Education Aggressive must include equity; got ${long}`,
    );
  });

  it('Education sub-2yr, explicit Aggressive override: equity HONORED, EquityEmerging still dropped', () => {
    // Explicit override bypasses the sub-2yr cash strip (horizon de-risk), but
    // the EquityEmerging drop is NOT horizon-driven and must still apply — the
    // rule is "skip horizon de-risking", not "skip all filters".
    const sub = categoriesOf(
      goal({ type: 'Education', targetDate: yearsFromNow(1), riskOverride: 'Aggressive' }),
    );
    assert.ok(
      sub.some((c) => ['AllEquity', 'EquityUS', 'EquityInternational', 'Growth'].includes(c)),
      `explicit Aggressive sub-2yr Education must surface equity; got ${sub}`,
    );
    assert.ok(
      !sub.includes('EquityEmerging'),
      `Education must still strip EquityEmerging even with override; got ${sub}`,
    );
  });
});

describe('recommendSecurities — fitScore tilts', () => {
  it('Aggressive Retirement: top pick is AllEquity/Growth, NOT cash', () => {
    const recs = recommendSecurities(
      goal({ type: 'Retirement', targetDate: yearsFromNow(25), riskOverride: 'Aggressive' }),
      { limit: 5 },
      NOW,
    );
    assert.ok(recs.length > 0, 'must return recs');
    const top = recs[0]!;
    assert.ok(
      ['AllEquity', 'Growth', 'EquityUS', 'EquityEmerging'].includes(top.security.category),
      `Aggressive top pick must be equity-flavoured, got ${top.security.ticker} (${top.security.category})`,
    );
    // No cash ticker should appear in the recommendations at all (it's not in the palette).
    for (const r of recs) {
      assert.notEqual(
        r.security.category,
        'CashEquivalent',
        `cash must not appear in Aggressive Retirement recs, saw ${r.security.ticker}`,
      );
    }
  });

  it('VeryLow gets zero-duration bonus → CASH.TO ranks at the top', () => {
    const recs = recommendSecurities(
      goal({ type: 'Retirement', targetDate: yearsFromNow(20), riskOverride: 'VeryLow' }),
      { limit: 5 },
      NOW,
    );
    assert.ok(recs.length > 0, 'must return recs');
    // Top pick must be a zero-duration cash instrument.
    const top = recs[0]!;
    assert.equal(
      top.security.category,
      'CashEquivalent',
      `VeryLow top pick must be cash; got ${top.security.ticker}`,
    );
    // CASH.TO has duration 0 and low MER → it should win against PSA.TO (also dur 0 but higher MER).
    const cashTo = recs.find((r) => r.security.ticker === 'CASH.TO');
    assert.ok(cashTo, 'CASH.TO must appear');
    assert.ok(
      top.fitScore >= cashTo!.fitScore - 1e-6,
      `top fitScore (${top.fitScore}) should be >= CASH.TO (${cashTo!.fitScore})`,
    );
    // And specifically CASH.TO should be in the top 2 (it shares duration 0 with PSA.TO).
    const topTwo = recs.slice(0, 2).map((r) => r.security.ticker);
    assert.ok(topTwo.includes('CASH.TO'), `CASH.TO must be in top-2; got ${topTwo}`);
  });

  it('5yr Withdrawal: switching risk visibly reshuffles recommendation tickers', () => {
    const base = { type: 'Withdrawal' as const, targetDate: yearsFromNow(5) };
    const lowTickers = tickersOf(goal({ ...base, riskOverride: 'VeryLow' }));
    const aggressiveTickers = tickersOf(goal({ ...base, riskOverride: 'Aggressive' }));
    assert.notDeepEqual(
      lowTickers,
      aggressiveTickers,
      `risk slider must change recommendations; both returned ${lowTickers}`,
    );
  });

  // --- Continuous fit score (granularity) -----------------------------------
  // The fit score used to collapse to ~2 buckets per goal because every
  // same-category holding got identical discrete tilts. The continuous
  // MER / yield / discovery terms must now spread same-cohort holdings out.

  it('two same-category ETFs with different MER get different fit scores', () => {
    // CASH.TO and PSA.TO are both cash-equivalent monthly payers with the same
    // currency/account fitness. Their different fees must still produce a spread.
    const g = goal({ type: 'Income', riskOverride: 'VeryLow', strategy: 'Income' });
    const recs = recommendSecurities(g, { limit: 30, goalAccountType: 'TFSA' }, NOW);
    const cash = recs.find((r) => r.security.ticker === 'CASH.TO');
    const psa = recs.find((r) => r.security.ticker === 'PSA.TO');
    assert.ok(cash && psa, 'both CASH.TO and PSA.TO must appear');
    assert.notEqual(
      cash!.fitScore,
      psa!.fitScore,
      `CASH.TO (${cash!.fitScore}) and PSA.TO (${psa!.fitScore}) must differ on MER`,
    );
  });

  it('Income: two covered-call ETFs with different yield get different fit scores', () => {
    // ZWU.TO (8% yield) vs ZWB.TO/ZWC.TO (7%) — same moderate NAV-erosion bucket
    // for ZWU/ZWC, so the continuous yield term is the differentiator.
    const g = goal({ type: 'Income', riskOverride: 'High', strategy: 'Income' });
    const recs = recommendSecurities(g, { limit: 30, goalAccountType: 'TFSA' }, NOW);
    const zwu = recs.find((r) => r.security.ticker === 'ZWU.TO');
    const zwc = recs.find((r) => r.security.ticker === 'ZWC.TO');
    assert.ok(zwu && zwc, 'both ZWU.TO and ZWC.TO must appear');
    assert.ok(
      zwu!.fitScore > zwc!.fitScore,
      `higher-yield ZWU.TO (${zwu!.fitScore}) must out-rank ZWC.TO (${zwc!.fitScore}) on the continuous yield term`,
    );
  });

  it("an Income goal's recommendations span a range, not 2 values", () => {
    // The regression we fixed: fits used to snap to ~2 distinct numbers (e.g.
    // 99 for CAD/optimal, 71 for US/suboptimal). Require a genuine spread now.
    const g = goal({
      type: 'DownPayment',
      targetDate: yearsFromNow(2),
      riskOverride: 'Aggressive',
      strategy: 'Income',
    });
    const recs = recommendSecurities(g, { limit: 10, goalAccountType: 'TFSA' }, NOW);
    assert.ok(recs.length >= 6, `need a populated list to test spread; got ${recs.length}`);
    const unique = new Set(recs.map((r) => r.fitScore));
    assert.ok(
      unique.size >= 4,
      `fit scores must span a range, not collapse to ~2 buckets; got ${[...unique].sort((a, b) => b - a).join(',')}`,
    );
    // And the scores must be clean integers in [0, 100].
    for (const r of recs) {
      assert.ok(
        Number.isInteger(r.fitScore) && r.fitScore >= 0 && r.fitScore <= 100,
        `${r.security.ticker} fit must be an integer in [0,100]; got ${r.fitScore}`,
      );
    }
  });

  it('yield does not inflate a Growth goal (continuous yield is Income-gated)', () => {
    // A Growth strategy drops dividend categories, but assert directly that the
    // yield term is gated: a high-yield holding must not get a yield bonus here.
    // Compare the SAME ticker scored under Income vs Growth strategy: the Income
    // run gets the yield emphasis, the Growth run does not.
    const incomeRec = recommendSecurities(
      goal({ type: 'Income', riskOverride: 'Moderate', strategy: 'Income' }),
      { limit: 30, goalAccountType: 'TFSA' },
      NOW,
    ).find((r) => r.security.ticker === 'XEI.TO');
    // Income (yield-gated ON) vs a non-income reference where the same ETF appears
    // without the yield emphasis. Use type=Custom + Balanced so XEI.TO still
    // surfaces (dividend sleeve) but the Income yield gate is OFF.
    const balancedRec = recommendSecurities(
      goal({ type: 'Custom', riskOverride: 'Moderate', strategy: 'Balanced' }),
      { limit: 30, goalAccountType: 'TFSA' },
      NOW,
    ).find((r) => r.security.ticker === 'XEI.TO');
    assert.ok(incomeRec && balancedRec, 'XEI.TO must appear under both strategies');
    // XEI.TO yields 5.4% → ~+6.48 yield bonus under Income only. Income strategy
    // also adds +6 dividend tilt; Balanced adds neither. So Income > Balanced by
    // strictly more than the 6-pt strategy tilt alone → proves the yield term fired.
    assert.ok(
      incomeRec!.fitScore - balancedRec!.fitScore > 6,
      `Income yield emphasis must lift XEI.TO beyond the strategy tilt alone (Income=${incomeRec!.fitScore}, Balanced=${balancedRec!.fitScore})`,
    );
  });

  it('discovery score nudges the curated fit continuously', () => {
    // NVDA is curated (IndividualStock, TFSA-optimal). Feeding a discoveryScore
    // for it must lift the fit vs no score, and a stronger score must lift more.
    const g = goal({
      type: 'Retirement',
      targetDate: yearsFromNow(25),
      riskOverride: 'Aggressive',
    });
    const base = recommendSecurities(g, { limit: 60, goalAccountType: 'TFSA' }, NOW).find(
      (r) => r.security.ticker === 'NVDA',
    );
    const nudged = recommendSecurities(
      g,
      { limit: 60, goalAccountType: 'TFSA', discoveryScoreByTicker: { NVDA: 4 } },
      NOW,
    ).find((r) => r.security.ticker === 'NVDA');
    const nudgedMore = recommendSecurities(
      g,
      { limit: 60, goalAccountType: 'TFSA', discoveryScoreByTicker: { NVDA: 8 } },
      NOW,
    ).find((r) => r.security.ticker === 'NVDA');
    assert.ok(base && nudged && nudgedMore, 'NVDA must appear in all three runs');
    assert.ok(
      nudged!.fitScore > base!.fitScore,
      `a discovery score must lift NVDA's fit (base=${base!.fitScore}, score4=${nudged!.fitScore})`,
    );
    assert.ok(
      nudgedMore!.fitScore > nudged!.fitScore,
      `a stronger discovery score must lift more without saturating (score4=${nudged!.fitScore}, score8=${nudgedMore!.fitScore})`,
    );
  });
});

describe('recommendSecurities — account-tax awareness (Phase 18)', () => {
  /** Helper: same goal, swap account-type, return top-N ticker sets. */
  function topTickers(g: GoalInput, account: string | undefined, n = 5): string[] {
    return recommendSecurities(
      g,
      account ? { limit: n, goalAccountType: account as never } : { limit: n },
      NOW,
    ).map((r) => r.security.ticker);
  }

  it('Aggressive Retirement + TFSA: favours no-div growth, avoids US dividend payers', () => {
    const g = goal({
      type: 'Retirement',
      targetDate: yearsFromNow(25),
      riskOverride: 'Aggressive',
    });
    const top = topTickers(g, 'TFSA', 8);

    // Should include at least one TFSA-optimal growth pick.
    const tfsaOptimal = [
      'NVDA',
      'TSLA',
      'AMD',
      'PLTR',
      'MSTR',
      'AVGO',
      'ARKK',
      'IWO',
      'TQQQ',
      'SOXL',
      'XBI',
      'BTCC.B.TO',
      'XEQT.TO',
      'VEQT.TO',
      'VFV.TO',
      'ZSP.TO',
      'VTI',
    ];
    const hits = top.filter((t) => tfsaOptimal.includes(t));
    assert.ok(hits.length > 0, `expected TFSA-optimal growth in top-8; got ${top}`);

    // Should NOT include SCHD/VYM (US div payers — withholding-hit in TFSA).
    for (const t of ['SCHD', 'VYM', 'O']) {
      assert.ok(!top.includes(t), `${t} must not appear in TFSA Aggressive top-8; got ${top}`);
    }
  });

  it('Aggressive Retirement + RRSP: includes SCHD/VYM/O, deprioritises TFSA-only growth', () => {
    const g = goal({
      type: 'Retirement',
      targetDate: yearsFromNow(25),
      riskOverride: 'Aggressive',
    });
    const top = topTickers(g, 'RRSP', 8);

    const usDivHits = top.filter((t) => ['SCHD', 'VYM', 'O'].includes(t));
    assert.ok(
      usDivHits.length >= 2,
      `RRSP Aggressive must include at least 2 of SCHD/VYM/O in top-8; got ${top}`,
    );

    // The TFSA-only growth picks (NVDA/TSLA/PLTR/MSTR/AMD/AVGO/ARKK/IWO/TQQQ/SOXL/XBI/BTCC.B.TO)
    // should be ranked lower than the RRSP-optimal SCHD/VYM/O — top-3 should not be
    // dominated by them.
    const tfsaOnlyGrowth = new Set([
      'NVDA',
      'TSLA',
      'AMD',
      'PLTR',
      'MSTR',
      'AVGO',
      'ARKK',
      'IWO',
      'TQQQ',
      'SOXL',
      'XBI',
      'BTCC.B.TO',
    ]);
    const top3 = top.slice(0, 3);
    const top3GrowthCount = top3.filter((t) => tfsaOnlyGrowth.has(t)).length;
    assert.ok(
      top3GrowthCount <= 1,
      `Top-3 in RRSP Aggressive should not be dominated by TFSA-only growth; got ${top3}`,
    );
  });

  it('Aggressive Retirement + Personal: favours Canadian eligible-dividend champions', () => {
    const g = goal({
      type: 'Retirement',
      targetDate: yearsFromNow(25),
      riskOverride: 'Aggressive',
    });
    const top = topTickers(g, 'Personal', 10);

    const cdnChampions = [
      'RY.TO',
      'BNS.TO',
      'BMO.TO',
      'TD.TO',
      'ENB.TO',
      'TRP.TO',
      'T.TO',
      'BCE.TO',
      'FTS.TO',
      'EMA.TO',
    ];
    const hits = top.filter((t) => cdnChampions.includes(t));
    assert.ok(
      hits.length >= 2,
      `Personal Aggressive must include at least 2 Cdn dividend champions; got ${top}`,
    );

    // SCHD/VYM should be penalised (FTC paperwork in non-reg) — should not appear top-3.
    const top3 = top.slice(0, 3);
    for (const t of ['SCHD', 'VYM']) {
      assert.ok(
        !top3.includes(t),
        `${t} should not be in Personal Aggressive top-3 (suboptimal outside RRSP); got ${top3}`,
      );
    }
  });

  it('EmergencyFund + RRSP: CASH.TO still recommended but flagged suboptimal', () => {
    const g = goal({ type: 'EmergencyFund' });
    const recs = recommendSecurities(g, { limit: 5, goalAccountType: 'RRSP' }, NOW);
    const cashTo = recs.find((r) => r.security.ticker === 'CASH.TO');
    assert.ok(cashTo, 'CASH.TO must still appear for EmergencyFund (cash-only palette)');
    assert.equal(
      cashTo!.optimalForAccount,
      false,
      'CASH.TO should NOT be flagged optimalForAccount in RRSP',
    );
    assert.ok(
      cashTo!.security.suboptimalAccounts.includes('RRSP'),
      'CASH.TO must carry suboptimal=RRSP',
    );
  });

  it('Same goal, TFSA vs RRSP → different recommendation set', () => {
    // With continuous fits, the cheapest broad-equity CAD ETFs (optimal in BOTH
    // wrappers) legitimately lead either account, so the account-specialised
    // picks differentiate further down the list rather than at the very top.
    // Assert the top-8 SET differs (RRSP surfaces US-div SCHD/VYM that TFSA drops).
    const g = goal({
      type: 'Retirement',
      targetDate: yearsFromNow(25),
      riskOverride: 'Aggressive',
    });
    const tfsa = topTickers(g, 'TFSA', 8);
    const rrsp = topTickers(g, 'RRSP', 8);
    assert.notDeepEqual(
      tfsa,
      rrsp,
      `TFSA vs RRSP must produce a different top-8; both returned ${tfsa}`,
    );
  });

  it('Same goal, TFSA vs Personal → different recommendation set', () => {
    const g = goal({
      type: 'Retirement',
      targetDate: yearsFromNow(25),
      riskOverride: 'Aggressive',
    });
    const tfsa = topTickers(g, 'TFSA', 8);
    const personal = topTickers(g, 'Personal', 8);
    assert.notDeepEqual(
      tfsa,
      personal,
      `TFSA vs Personal must produce a different top-8; both returned ${tfsa}`,
    );
  });

  it('Corporate + Aggressive routes to Personal tax logic (integrated tax)', () => {
    const g = goal({
      type: 'Retirement',
      targetDate: yearsFromNow(25),
      riskOverride: 'Aggressive',
    });
    const corporate = topTickers(g, 'Corporate', 5);
    const personal = topTickers(g, 'Personal', 5);
    assert.deepEqual(
      corporate,
      personal,
      `Corporate must follow Personal tax logic; got Corp=${corporate} vs Personal=${personal}`,
    );
  });

  it('optimalForAccount + taxRationale are exposed on returned recommendations', () => {
    const g = goal({
      type: 'Retirement',
      targetDate: yearsFromNow(25),
      riskOverride: 'Aggressive',
    });
    const recs = recommendSecurities(g, { limit: 10, goalAccountType: 'TFSA' }, NOW);
    // At least one of the recs should be flagged optimal + carry a rationale.
    const flagged = recs.find((r) => r.optimalForAccount && r.taxRationale);
    assert.ok(
      flagged,
      'expected at least one recommendation with optimalForAccount=true and a taxRationale',
    );
  });

  it('no goalAccountType → optimalForAccount=false, no taxRationale (backwards compat)', () => {
    const g = goal({
      type: 'Retirement',
      targetDate: yearsFromNow(25),
      riskOverride: 'Aggressive',
    });
    const recs = recommendSecurities(g, { limit: 5 }, NOW);
    for (const r of recs) {
      assert.equal(
        r.optimalForAccount,
        false,
        `${r.security.ticker}: optimalForAccount must be false`,
      );
      assert.equal(
        r.taxRationale,
        undefined,
        `${r.security.ticker}: taxRationale must be undefined`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Strategy axis — orthogonal to type+risk. Strategy narrows the candidate
// categories without overriding the tax-fitness logic (recommendAccount /
// optimalForAccount / taxRationale stay identical).
// ---------------------------------------------------------------------------

describe('recommendSecurities — strategy axis', () => {
  function topTickers(g: GoalInput, n = 8, account?: string): string[] {
    return recommendSecurities(
      g,
      account ? { limit: n, goalAccountType: account as never } : { limit: n },
      NOW,
    ).map((r) => r.security.ticker);
  }

  it('Retirement Aggressive + strategy=Income: top picks are dividend payers, not all-equity', () => {
    const g = goal({
      type: 'Retirement',
      targetDate: yearsFromNow(25),
      riskOverride: 'Aggressive',
      strategy: 'Income',
    });
    const top = topTickers(g, 8);
    const incomeNames = ['QQQI', 'SPYI', 'JEPI', 'JEPQ', 'HMAX.TO', 'HDIV.TO', 'ZWU.TO'];
    const equityNames = ['XEQT.TO', 'VEQT.TO', 'VFV.TO', 'ZSP.TO', 'VTI'];
    const incomeHits = top.filter((t) => incomeNames.includes(t));
    const equityHits = top.filter((t) => equityNames.includes(t));
    assert.ok(
      incomeHits.length >= 1,
      `Income strategy must surface at least one high-income payer; got ${top}`,
    );
    assert.ok(
      incomeHits.length > equityHits.length || equityHits.length === 0,
      `Income strategy picks (${incomeHits.length}) must dominate all-equity (${equityHits.length}); got ${top}`,
    );
  });

  it('Retirement Aggressive + strategy=Growth: top picks include growth ETFs, NOT US dividend funds', () => {
    const g = goal({
      type: 'Retirement',
      targetDate: yearsFromNow(25),
      riskOverride: 'Aggressive',
      strategy: 'Growth',
    });
    const top = topTickers(g, 8);
    const growthNames = ['XEQT.TO', 'VEQT.TO', 'VFV.TO', 'ZSP.TO', 'VTI', 'IWO', 'ARKK', 'TQQQ'];
    const hits = top.filter((t) => growthNames.includes(t));
    assert.ok(hits.length >= 1, `Growth strategy must surface at least one growth ETF; got ${top}`);
    for (const t of ['SCHD', 'VYM', 'VDY.TO', 'ZDV.TO']) {
      assert.ok(!top.includes(t), `Growth strategy must exclude ${t}; got ${top}`);
    }
  });

  it('Custom + strategy=Preservation: cash/short-bond only regardless of risk', () => {
    const risks: RiskTolerance[] = ['VeryLow', 'Moderate', 'Aggressive'];
    for (const r of risks) {
      const g = goal({ type: 'Custom', riskOverride: r, strategy: 'Preservation' });
      const cats = categoriesOf(g);
      // Preservation forces cash + short-bond only.
      for (const c of cats) {
        assert.ok(
          c === 'CashEquivalent' || c === 'ShortTermBond',
          `Preservation must yield only cash/short-bond; got ${c} at risk=${r} (full set ${cats})`,
        );
      }
      assert.ok(cats.includes('CashEquivalent'), `Preservation must include cash at risk=${r}`);
    }
  });

  it('Retirement Aggressive + strategy=null: identical to existing pre-strategy behavior', () => {
    const base = {
      type: 'Retirement' as const,
      targetDate: yearsFromNow(25),
      riskOverride: 'Aggressive' as const,
    };
    const without = tickersOf(goal(base));
    const withNull = tickersOf(goal({ ...base, strategy: null }));
    assert.deepEqual(
      withNull,
      without,
      `strategy=null must match unset behaviour; got null=${withNull} unset=${without}`,
    );
  });

  it('Tax-fitness still fires under strategy: TFSA vs RRSP with strategy=Growth yield different top picks', () => {
    const base = {
      type: 'Retirement' as const,
      targetDate: yearsFromNow(25),
      riskOverride: 'Aggressive' as const,
      strategy: 'Growth' as GoalStrategy,
    };
    // Use limit=15 so individual stocks surface past the broad-equity leaders;
    // tax-fitness reshuffles those names by account.
    const tfsa = topTickers(goal(base), 15, 'TFSA');
    const rrsp = topTickers(goal(base), 15, 'RRSP');
    assert.notDeepEqual(
      tfsa,
      rrsp,
      `Growth strategy: TFSA vs RRSP must still reshuffle via tax logic; both ${tfsa}`,
    );
  });

  it('Strategy=Income overrides type=Retirement default (which would skew all-equity)', () => {
    const aggressiveDefault = categoriesOf(
      goal({ type: 'Retirement', targetDate: yearsFromNow(25), riskOverride: 'Aggressive' }),
    );
    const aggressiveIncome = categoriesOf(
      goal({
        type: 'Retirement',
        targetDate: yearsFromNow(25),
        riskOverride: 'Aggressive',
        strategy: 'Income',
      }),
    );
    assert.notDeepEqual(
      aggressiveDefault,
      aggressiveIncome,
      'Income strategy must change palette vs the type default',
    );
    // Income strategy must NOT include the broad equity-only categories that
    // saturate the default Aggressive Retirement palette.
    for (const c of ['AllEquity', 'EquityEmerging', 'LeveragedETF']) {
      assert.ok(
        !aggressiveIncome.includes(c),
        `Income strategy must drop ${c}; got ${aggressiveIncome}`,
      );
    }
  });

  it('Strategy=Balanced ensures growth + bond + dividend sleeves are all represented', () => {
    // Use Moderate risk so the Aggressive equity tilts don't push dividend
    // categories below the top-N picks the categoriesOf helper inspects.
    const g = goal({
      type: 'Retirement',
      targetDate: yearsFromNow(20),
      riskOverride: 'Moderate',
      strategy: 'Balanced',
    });
    const cats = categoriesOf(g);
    const hasGrowth = cats.some((c) =>
      ['AllEquity', 'Growth', 'EquityUS', 'EquityCanadian', 'EquityInternational'].includes(c),
    );
    const hasDividend = cats.some((c) => ['DividendCanadian', 'DividendUS', 'REIT'].includes(c));
    const hasBond = cats.some((c) =>
      ['ShortTermBond', 'IntermediateBond', 'CashEquivalent', 'Balanced'].includes(c),
    );
    assert.ok(hasGrowth, `Balanced must include a growth category; got ${cats}`);
    assert.ok(hasDividend, `Balanced must include a dividend category; got ${cats}`);
    assert.ok(hasBond, `Balanced must include a bond/cash/balanced category; got ${cats}`);
  });

  it('Strategy=Balanced no longer leaks equity into VeryLow', () => {
    const g = goal({
      type: 'Retirement',
      targetDate: yearsFromNow(20),
      riskOverride: 'VeryLow',
      strategy: 'Balanced',
    });
    const cats = categoriesOf(g);
    for (const c of cats) {
      assert.ok(
        c === 'CashEquivalent' || c === 'ShortTermBond',
        `VeryLow Balanced must stay cash/short-bond only; got ${cats}`,
      );
    }
  });

  it('Strategy=Balanced walks the allocation ladder by risk tier', () => {
    const base = {
      type: 'Retirement' as const,
      targetDate: yearsFromNow(20),
      strategy: 'Balanced' as GoalStrategy,
    };
    const veryLow = tickersOf(goal({ ...base, riskOverride: 'VeryLow' }), 5);
    const low = tickersOf(goal({ ...base, riskOverride: 'Low' }), 5);
    const moderate = tickersOf(goal({ ...base, riskOverride: 'Moderate' }), 5);
    const high = tickersOf(goal({ ...base, riskOverride: 'High' }), 5);
    const aggressive = recommendSecurities(
      goal({ ...base, riskOverride: 'Aggressive' }),
      { limit: 5, goalAccountType: 'TFSA' },
      NOW,
    );

    assert.ok(
      veryLow.some((t) => ['CASH.TO', 'CBIL.TO', 'PSA.TO'].includes(t)),
      `VeryLow must be cash-led; got ${veryLow}`,
    );
    assert.ok(
      low.some((t) => ['XINC.TO', 'XCNS.TO'].includes(t)),
      `Low must include conservative all-in-one funds; got ${low}`,
    );
    assert.ok(moderate.includes('XBAL.TO'), `Moderate must include 60/40 XBAL.TO; got ${moderate}`);
    assert.ok(high.includes('XGRO.TO'), `High must include 80/20 XGRO.TO; got ${high}`);
    assert.ok(
      aggressive.some((r) =>
        ['Speculative', 'EquityEmerging', 'SectorEquity'].includes(r.security.category),
      ),
      `Aggressive Balanced must add a higher-risk satellite; got ${aggressive.map((r) => `${r.security.ticker}:${r.security.category}`)}`,
    );
  });

  it('Growth High and Growth Aggressive differ, with Aggressive adding a satellite sleeve', () => {
    const base = {
      type: 'Retirement' as const,
      targetDate: yearsFromNow(20),
      strategy: 'Growth' as GoalStrategy,
    };
    const high = tickersOf(goal({ ...base, riskOverride: 'High' }), 5);
    const aggressive = recommendSecurities(
      goal({ ...base, riskOverride: 'Aggressive' }),
      { limit: 5, goalAccountType: 'TFSA' },
      NOW,
    );
    assert.notDeepEqual(
      aggressive.map((r) => r.security.ticker),
      high,
      `Growth High and Aggressive must not collapse to the same list; both got ${high}`,
    );
    assert.ok(
      aggressive.some((r) =>
        [
          'LeveragedETF',
          'Speculative',
          'CryptoAdjacent',
          'SectorEquity',
          'IndividualStock',
        ].includes(r.security.category),
      ),
      `Aggressive Growth must include a higher-risk satellite; got ${aggressive.map((r) => `${r.security.ticker}:${r.security.category}`)}`,
    );
  });

  it('Income introduces sustainable option income at High and complex high-yield at Aggressive', () => {
    const base = { type: 'Income' as const, strategy: 'Income' as GoalStrategy };
    const high = tickersOf(goal({ ...base, riskOverride: 'High' }), 30);
    const aggressive = tickersOf(goal({ ...base, riskOverride: 'Aggressive' }), 30);
    assert.ok(
      high.some((ticker) => ['JEPI', 'ZWB.TO', 'ZWU.TO', 'ZWC.TO', 'MAIN'].includes(ticker)),
      `High Income must add vetted sustainable option/credit income; got ${high}`,
    );
    assert.ok(
      !high.some((ticker) => ['QQQI', 'SPYI', 'JEPQ', 'HMAX.TO', 'HDIV.TO'].includes(ticker)),
      `High Income must not leak Aggressive-only products; got ${high}`,
    );
    assert.ok(
      aggressive.some((ticker) => ['QQQI', 'SPYI', 'JEPQ', 'HMAX.TO', 'HDIV.TO'].includes(ticker)),
      `Aggressive Income must unlock complex high-yield products; got ${aggressive}`,
    );
    assert.notDeepEqual(high, aggressive);
  });

  it('EmergencyFund + strategy=Growth: hard constraint still wins (cash-only)', () => {
    const g = goal({ type: 'EmergencyFund', strategy: 'Growth' });
    const cats = categoriesOf(g);
    assert.deepEqual(
      cats,
      ['CashEquivalent'],
      `EmergencyFund hard cap must beat strategy=Growth; got ${cats}`,
    );
  });
});

describe('deriveRiskTolerance — sanity', () => {
  it('honours explicit override', () => {
    const g = goal({ type: 'Retirement', riskOverride: 'Aggressive' });
    assert.equal(deriveRiskTolerance(g, NOW), 'Aggressive');
  });

  it('EmergencyFund forces VeryLow when no override', () => {
    const g = goal({ type: 'EmergencyFund' });
    assert.equal(deriveRiskTolerance(g, NOW), 'VeryLow');
  });
});

// ---------------------------------------------------------------------------
// Explicit risk override wins over horizon de-risking. Horizon stays the smart
// default (no-override path unchanged), but an explicit riskOverride is a
// conscious signal honored across categories + glide — EXCEPT EmergencyFund,
// which stays cash-locked. An honest risk-vs-horizon warning accompanies it.
// ---------------------------------------------------------------------------

describe('explicit override wins over horizon de-risking', () => {
  // Goal 1 mirror: DownPayment, ~12mo out, Aggressive + Income, TFSA-funded.
  const goal1 = (): GoalInput =>
    goal({
      type: 'DownPayment',
      targetAmountCad: 20_000,
      targetDate: daysFromNow(365),
      riskOverride: 'Aggressive',
      strategy: 'Income',
    });

  it('DownPayment <1yr + Aggressive + Income → aggressive income palette, NOT cash', () => {
    const cats = categoriesOf(goal1());
    assert.ok(!cats.includes('CashEquivalent'), `must not be cashed; got ${cats}`);
    // The shared 8% floor deliberately strips lower-yield dividend sleeves.
    assert.ok(
      cats.includes('CoveredCall'),
      `aggressive income must include CoveredCall; got ${cats}`,
    );
    // Top picks must be the aggressive-income names, not CASH/CBIL/PSA.
    const top = tickersOf(goal1(), 6);
    for (const t of ['CASH.TO', 'CBIL.TO', 'PSA.TO']) {
      assert.ok(
        !top.includes(t),
        `${t} must NOT be a top pick once override is honored; got ${top}`,
      );
    }
  });

  it('DownPayment <1yr + Aggressive → glideAllocation is 100% equity (rate follows)', () => {
    const g = glideAllocation(goal1(), NOW);
    assert.deepEqual(
      g,
      { cashPct: 0, bondPct: 0, equityPct: 100 },
      `explicit Aggressive must drive a 100% equity glide; got ${JSON.stringify(g)}`,
    );
  });

  it('DownPayment <1yr + Aggressive → risk-horizon warning is emitted', () => {
    const warn = riskHorizonOverrideWarning(goal1(), NOW);
    assert.ok(warn, 'expected a risk-horizon-override warning');
    assert.equal(warn!.kind, 'risk-horizon-override');
    assert.deepEqual(warn!.goalIds, [1]);
    assert.match(warn!.message, /Aggressive/);
    assert.match(warn!.message, /12-month/);
    assert.match(warn!.message, /DownPayment/);
    assert.match(warn!.message, /swing/i);
    // detectConflicts surfaces it on the banner too.
    const conflicts = detectConflicts([goal1()], [], [], NOW);
    assert.ok(
      conflicts.some((c) => c.kind === 'risk-horizon-override' && c.goalIds.includes(1)),
      `detectConflicts must surface the risk-horizon-override; got ${JSON.stringify(conflicts)}`,
    );
  });

  it('EmergencyFund + Aggressive override → STILL cash (categories + glide), no warning', () => {
    // The one carve-out: EmergencyFund stays cash-locked even with an override.
    const ef = goal({
      type: 'EmergencyFund',
      targetDate: daysFromNow(180),
      riskOverride: 'Aggressive',
    });
    assert.deepEqual(
      categoriesOf(ef),
      ['CashEquivalent'],
      'EmergencyFund override must stay cash-only',
    );
    assert.deepEqual(
      glideAllocation(ef, NOW),
      { cashPct: 100, bondPct: 0, equityPct: 0 },
      'EmergencyFund override must stay 100% cash glide',
    );
    assert.equal(
      riskHorizonOverrideWarning(ef, NOW),
      null,
      'EmergencyFund carries no swing risk → no warning',
    );
  });

  it('No-override short-horizon DownPayment → unchanged (cash + VeryLow glide, no warning)', () => {
    const g = goal({ type: 'DownPayment', targetDate: daysFromNow(180), riskOverride: null });
    assert.deepEqual(
      categoriesOf(g),
      ['CashEquivalent'],
      'no-override short DownPayment stays cash',
    );
    assert.deepEqual(
      glideAllocation(g, NOW),
      { cashPct: 100, bondPct: 0, equityPct: 0 },
      'no-override short DownPayment glides to 100% cash (VeryLow)',
    );
    assert.equal(riskHorizonOverrideWarning(g, NOW), null, 'no override → no warning');
  });

  it('warning does NOT fire for a long-horizon override (horizon would not de-risk)', () => {
    // 5yr DownPayment, Aggressive: horizon-derived risk is already Moderate and
    // h >= 3, so honoring the override is not a near-dated mismatch — no warning.
    const g = goal({
      type: 'DownPayment',
      targetDate: yearsFromNow(5),
      riskOverride: 'Aggressive',
    });
    assert.equal(riskHorizonOverrideWarning(g, NOW), null, 'long-horizon override must not warn');
  });
});

describe('detectConflicts — account-room-shortfall', () => {
  it('uses shortfall per goal instead of raw target', () => {
    const accounts: AccountSummary[] = [
      account({ id: 1, type: 'TFSA', contributionRoomCad: 12_000 }),
    ];

    const shortFunding = goal({
      id: 1,
      type: 'Retirement',
      targetAmountCad: 20_000,
      currentValueCad: 13_000,
    });
    const veryShort = goal({
      id: 2,
      type: 'Retirement',
      targetAmountCad: 25_000,
      currentValueCad: 1_000,
    });
    const conflicts = detectConflicts([shortFunding, veryShort], [], accounts, NOW);

    assert.equal(conflicts.length, 1);
    const c = conflicts[0]!;
    assert.equal(c.kind, 'account-room-shortfall');
    assert.deepEqual(c.goalIds, [1, 2]);
    assert.match(c.message, /shortfall/);
  });

  it('honors explicit accountId over recommendation ranking for room grouping', () => {
    const accounts: AccountSummary[] = [
      account({ id: 1, type: 'RRSP', contributionRoomCad: 10_000 }),
      account({ id: 2, type: 'TFSA', contributionRoomCad: 5_000 }),
    ];

    const explicit1 = goal({
      id: 1,
      type: 'DownPayment',
      accountId: 1,
      targetAmountCad: 12_000,
      currentValueCad: 1_000,
    });
    const explicit2 = goal({
      id: 2,
      type: 'DownPayment',
      accountId: 1,
      targetAmountCad: 12_000,
      currentValueCad: 1_000,
    });
    const autoTfsa1 = goal({
      id: 3,
      type: 'DownPayment',
      targetAmountCad: 12_000,
      currentValueCad: 1_000,
    });
    const autoTfsa2 = goal({
      id: 4,
      type: 'DownPayment',
      targetAmountCad: 12_000,
      currentValueCad: 1_000,
    });

    const conflicts = detectConflicts(
      [explicit1, explicit2, autoTfsa1, autoTfsa2],
      [],
      accounts,
      NOW,
    );

    assert.equal(conflicts.length, 2);
    const byType = new Map(conflicts.map((c) => [c.goalIds.includes(1) ? 'RRSP' : 'TFSA', c]));
    const rrsp = byType.get('RRSP');
    const tfsa = byType.get('TFSA');
    assert.ok(rrsp);
    assert.ok(tfsa);
    assert.deepEqual(rrsp!.goalIds, [1, 2]);
    assert.deepEqual(tfsa!.goalIds, [3, 4]);
    assert.match(rrsp!.message, /shortfall/);
    assert.match(tfsa!.message, /shortfall/);
  });
});

describe('detectConflicts — horizon-mismatch', () => {
  it('flags a short-horizon goal when linked USD positions are present', () => {
    const shortGoal = goal({
      id: 1,
      type: 'DownPayment',
      targetDate: daysFromNow(365),
      riskOverride: null,
      targetAmountCad: 25_000,
    });
    const longGoal = goal({
      id: 2,
      type: 'Retirement',
      targetDate: yearsFromNow(12),
      riskOverride: null,
      targetAmountCad: 50_000,
    });
    const shortCad = linked({
      positionId: 1,
      shares: 1,
      latestClose: 100,
      currency: 'USD',
      allocation: 1,
      goalId: 1,
    });
    const longCad = linked({
      positionId: 2,
      shares: 1,
      latestClose: 100,
      currency: 'CAD',
      allocation: 1,
      goalId: 2,
    });

    const conflicts = detectConflicts([shortGoal, longGoal], [shortCad, longCad], [], NOW);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0]!.kind, 'horizon-mismatch');
    assert.deepEqual(conflicts[0]!.goalIds, [1]);
  });

  it('does not flag a long-horizon goal', () => {
    const longHorizon = goal({
      id: 1,
      type: 'DownPayment',
      targetDate: yearsFromNow(3),
      riskOverride: null,
      targetAmountCad: 25_000,
    });
    const shortPos = linked({
      positionId: 1,
      shares: 1,
      latestClose: 100,
      currency: 'USD',
      allocation: 1,
      goalId: 1,
    });
    const conflicts = detectConflicts([longHorizon], [shortPos], [], NOW);
    assert.equal(
      conflicts.some((c) => c.kind === 'horizon-mismatch'),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Discovery picks merge — Phase 19. Engine stays sync, takes the picks via
// `opts.discoveryPicks`. The loader (`loadTopDiscoveryPicks`) is exercised
// separately by integration tests that have a real DB; here we synthesize
// realistic picks and verify the merge + scoring path.
// ---------------------------------------------------------------------------

function pick(overrides: Partial<DiscoveryPick> & { ticker: string }): DiscoveryPick {
  return {
    name: overrides.ticker,
    score: 5,
    currency: 'USD',
    listingCountry: 'US',
    hasDividend: false,
    isUsDivPayer: false,
    marketCapUsd: 100_000_000_000,
    sector: 'Technology',
    isLottery: false,
    ...overrides,
  };
}

describe('recommendSecurities — discovery pick merge', () => {
  const aggressiveTfsa = goal({
    type: 'Retirement',
    targetDate: yearsFromNow(25),
    riskOverride: 'Aggressive',
  });

  it('Aggressive Retirement TFSA: includes at least one discovery-kind pick', () => {
    // Wider limit gives discovery satellites room past the curated leaders.
    // The UI uses limit=5 by default; this test exercises the expanded merge.
    const recs = recommendSecurities(
      aggressiveTfsa,
      {
        limit: 30,
        goalAccountType: 'TFSA',
        discoveryPicks: [
          pick({ ticker: 'CRWD', score: 8.5 }),
          pick({ ticker: 'DDOG', score: 8.0 }),
          pick({ ticker: 'NET', score: 7.5 }),
        ],
      },
      NOW,
    );
    const discovery = recs.filter((r) => r.kind === 'discovery');
    assert.ok(
      discovery.length > 0,
      `Aggressive Retirement TFSA must surface ≥1 discovery pick; got ${recs.map((r) => `${r.security.ticker}(${r.kind})`).join(',')}`,
    );
    // Discovery picks should carry the underlying score.
    for (const d of discovery) {
      assert.ok(d.discoveryScore !== undefined, `${d.security.ticker}: discoveryScore must be set`);
    }
  });

  it('Low-risk EmergencyFund: zero discovery picks even when supplied', () => {
    const g = goal({ type: 'EmergencyFund' });
    const recs = recommendSecurities(
      g,
      {
        limit: 8,
        goalAccountType: 'TFSA',
        // Supply picks; engine should ignore them because risk = VeryLow.
        discoveryPicks: [pick({ ticker: 'NVDA', score: 7.5 })],
      },
      NOW,
    );
    const discovery = recs.filter((r) => r.kind === 'discovery');
    assert.equal(
      discovery.length,
      0,
      `EmergencyFund must reject discovery picks; got ${discovery.map((d) => d.security.ticker)}`,
    );
  });

  it('Aggressive RRSP: discovery picks favour US div payers over no-div growth', () => {
    const g = goal({
      type: 'Retirement',
      targetDate: yearsFromNow(25),
      riskOverride: 'Aggressive',
    });
    // Use non-curated tickers (MO, PFE, CRWD) so the discovery scoring is the
    // only signal — avoids interference with curated NVDA/TSLA bonuses.
    const recs = recommendSecurities(
      g,
      {
        limit: 60,
        goalAccountType: 'RRSP',
        discoveryPicks: [
          pick({
            ticker: 'MO',
            score: 4.5,
            hasDividend: true,
            isUsDivPayer: true,
            sector: 'Consumer Staples',
          }),
          pick({
            ticker: 'PFE',
            score: 4.5,
            hasDividend: true,
            isUsDivPayer: true,
            sector: 'Healthcare',
          }),
          pick({ ticker: 'CRWD', score: 4.5, hasDividend: false, isUsDivPayer: false }),
        ],
      },
      NOW,
    );
    const discovery = recs.filter((r) => r.kind === 'discovery');
    const moRec = discovery.find((d) => d.security.ticker === 'MO');
    const crwdRec = discovery.find((d) => d.security.ticker === 'CRWD');
    assert.ok(moRec && crwdRec, 'both picks must appear');
    assert.ok(
      moRec!.fitScore > crwdRec!.fitScore,
      `RRSP must score US div payer (MO=${moRec!.fitScore}) above non-div growth (CRWD=${crwdRec!.fitScore})`,
    );
    assert.equal(moRec!.optimalForAccount, true, 'US div payer in RRSP must be flagged optimal');
  });

  it('Aggressive TFSA: discovery picks favour non-div growth over US div payers', () => {
    const g = goal({
      type: 'Retirement',
      targetDate: yearsFromNow(25),
      riskOverride: 'Aggressive',
    });
    // Use tickers NOT in the curated pool to isolate the discovery scoring.
    const recs = recommendSecurities(
      g,
      {
        limit: 60,
        goalAccountType: 'TFSA',
        discoveryPicks: [
          pick({
            ticker: 'MO',
            score: 4.5,
            hasDividend: true,
            isUsDivPayer: true,
            sector: 'Consumer Staples',
          }),
          pick({ ticker: 'CRWD', score: 4.5, hasDividend: false, isUsDivPayer: false }),
        ],
      },
      NOW,
    );
    const moRec = recs.find((r) => r.security.ticker === 'MO' && r.kind === 'discovery');
    const crwdRec = recs.find((r) => r.security.ticker === 'CRWD' && r.kind === 'discovery');
    assert.ok(moRec && crwdRec, 'both picks must appear');
    assert.ok(
      crwdRec!.fitScore > moRec!.fitScore,
      `TFSA must score non-div growth (CRWD=${crwdRec!.fitScore}) above US div payer (MO=${moRec!.fitScore})`,
    );
    assert.equal(
      crwdRec!.optimalForAccount,
      true,
      'non-div growth in TFSA must be flagged optimal',
    );
  });

  it('Discovery picks do not duplicate curated tickers', () => {
    const g = goal({
      type: 'Retirement',
      targetDate: yearsFromNow(25),
      riskOverride: 'Aggressive',
    });
    // NVDA is in the curated pool (IndividualStock). Supply it as a discovery
    // pick too; engine must dedupe. Use a high limit so NVDA surfaces in the
    // result regardless of curated ranking.
    const recs = recommendSecurities(
      g,
      {
        limit: 60,
        goalAccountType: 'TFSA',
        discoveryPicks: [pick({ ticker: 'NVDA', score: 7.5 })],
      },
      NOW,
    );
    const nvdaEntries = recs.filter((r) => r.security.ticker === 'NVDA');
    assert.equal(nvdaEntries.length, 1, `NVDA must appear exactly once; got ${nvdaEntries.length}`);
    assert.equal(nvdaEntries[0]!.kind, 'curated', 'curated NVDA must win the dedupe');
  });

  it('includeDiscoveryPicks: false disables the merge even when picks are passed', () => {
    const g = goal({
      type: 'Retirement',
      targetDate: yearsFromNow(25),
      riskOverride: 'Aggressive',
    });
    const recs = recommendSecurities(
      g,
      {
        limit: 10,
        goalAccountType: 'TFSA',
        includeDiscoveryPicks: false,
        discoveryPicks: [pick({ ticker: 'CRWD', score: 8 })],
      },
      NOW,
    );
    const discovery = recs.filter((r) => r.kind === 'discovery');
    assert.equal(
      discovery.length,
      0,
      `explicit false must suppress discovery; got ${discovery.map((d) => d.security.ticker)}`,
    );
  });

  it('No discoveryPicks supplied → result identical to pre-Phase-19 behaviour', () => {
    const g = goal({
      type: 'Retirement',
      targetDate: yearsFromNow(25),
      riskOverride: 'Aggressive',
    });
    const a = recommendSecurities(g, { limit: 5, goalAccountType: 'TFSA' }, NOW);
    const b = recommendSecurities(
      g,
      { limit: 5, goalAccountType: 'TFSA', discoveryPicks: [] },
      NOW,
    );
    assert.deepEqual(
      a.map((r) => r.security.ticker),
      b.map((r) => r.security.ticker),
      'empty discovery picks must not perturb the curated ordering',
    );
  });
});

// ---------------------------------------------------------------------------
// High-yield-high-risk tier. High adds vetted sustainable option/credit income;
// Aggressive unlocks the 8%+ complex/high-erosion sleeve. Growth never pulls
// yield, and YieldMax-style names remain blocked.
// ---------------------------------------------------------------------------

describe('recommendSecurities — high-yield-high-risk (CoveredCall) tier', () => {
  function topTickers(g: GoalInput, account: string | undefined, n = 12): string[] {
    return recommendSecurities(
      g,
      account ? { limit: n, goalAccountType: account as never } : { limit: n },
      NOW,
    ).map((r) => r.security.ticker);
  }

  it('Aggressive + Income: CoveredCall present, QQQI/JEPI surface, ranked above HDIV', () => {
    const g = goal({ type: 'Income', riskOverride: 'Aggressive' });
    const cats = categoriesOf(g);
    assert.ok(
      cats.includes('CoveredCall'),
      `Aggressive Income must include the CoveredCall tier; got ${cats}`,
    );

    // Score the full tier (RRSP wrapper → US covered-call/BDC optimal).
    const recs = recommendSecurities(g, { limit: 30, goalAccountType: 'RRSP' }, NOW);
    const byTicker = new Map(recs.map((r) => [r.security.ticker, r]));
    assert.ok(byTicker.has('QQQI'), `QQQI must surface; got ${[...byTicker.keys()]}`);
    assert.ok(byTicker.has('JEPI'), `JEPI must surface; got ${[...byTicker.keys()]}`);
    const hdiv = recs.find((r) => r.security.ticker === 'HDIV.TO');
    if (hdiv) {
      // Sustainable spread-based income must out-rank the leveraged trap.
      assert.ok(
        byTicker.get('QQQI')!.fitScore > hdiv.fitScore,
        `QQQI (${byTicker.get('QQQI')!.fitScore}) must out-rank HDIV.TO (${hdiv.fitScore}) via NAV-erosion penalty`,
      );
      assert.ok(
        byTicker.get('JEPI')!.fitScore > hdiv.fitScore,
        `JEPI (${byTicker.get('JEPI')!.fitScore}) must out-rank HDIV.TO (${hdiv.fitScore})`,
      );
    }
  });

  it('Income recommendations contain only approved monthly payers', () => {
    const recs = recommendSecurities(
      goal({ type: 'Income', riskOverride: 'Aggressive', strategy: 'Income' }),
      { limit: 100, goalAccountType: 'TFSA' },
      NOW,
    );

    assert.ok(recs.length > 0);
    for (const rec of recs) {
      assert.ok(
        MONTHLY_INCOME_TICKERS.has(rec.security.ticker.toUpperCase()),
        `${rec.security.ticker} is not an approved monthly payer`,
      );
    }
  });

  it('uses live yield overrides for the shared floor and visible rationale', () => {
    const moderateGoal = goal({
      type: 'Income',
      riskOverride: 'Moderate',
      strategy: 'Income',
    });
    const baseline = recommendSecurities(moderateGoal, { limit: 100 }, NOW);
    assert.ok(baseline.some((rec) => rec.security.ticker === 'O'));

    const belowFloor = recommendSecurities(
      moderateGoal,
      { limit: 100, incomeYieldByTicker: { O: 0.04 } },
      NOW,
    );
    assert.ok(!belowFloor.some((rec) => rec.security.ticker === 'O'));

    const aggressive = recommendSecurities(
      goal({ type: 'Income', riskOverride: 'Aggressive', strategy: 'Income' }),
      {
        limit: 100,
        incomeYieldByTicker: { 'HMAX.TO': 0.085 },
      },
      NOW,
    );
    const hmax = aggressive.find((rec) => rec.security.ticker === 'HMAX.TO');
    assert.ok(hmax);
    assert.equal((hmax.security as { expectedYield?: number }).expectedYield, 0.085);
    assert.equal(hmax.incomeYield, 0.085);
    assert.equal(hmax.incomeYieldSource, 'metrics');
    assert.match(hmax.reason, /~8\.5% reported TTM yield/);

    const fallback = baseline.find((rec) => rec.security.ticker === 'O');
    assert.ok(fallback);
    assert.equal(fallback.incomeYieldSource, 'curated');
    assert.match(fallback.reason, /reviewed yield estimate/);
  });

  it('every Income tier has a distinct slate and honors the shared yield floor', () => {
    const risks: RiskTolerance[] = ['VeryLow', 'Low', 'Moderate', 'High', 'Aggressive'];
    const slates: string[] = [];

    for (const risk of risks) {
      const recs = recommendSecurities(
        goal({ type: 'Income', riskOverride: risk, strategy: 'Income' }),
        { limit: 100 },
        NOW,
      );
      const minYield = INCOME_RISK_PROFILES[GOAL_INCOME_RISK_KEYS[risk]].minYield;
      assert.ok(recs.length > 0, `${risk} Income must have at least one recommendation`);
      for (const rec of recs) {
        const rawYield = (rec.security as { expectedYield?: unknown }).expectedYield;
        const expectedYield = typeof rawYield === 'number' ? rawYield : 0;
        assert.ok(
          expectedYield >= minYield,
          `${risk} leaked ${rec.security.ticker} at ${expectedYield * 100}% below ${minYield * 100}%`,
        );
      }
      slates.push(recs.map((rec) => rec.security.ticker).join(','));
    }

    assert.equal(
      new Set(slates).size,
      risks.length,
      `Income tiers collapsed: ${slates.join(' | ')}`,
    );
  });

  it('Income discovery merge rejects quarterly names and keeps approved monthly names', () => {
    const recs = recommendSecurities(
      goal({ type: 'Income', riskOverride: 'Aggressive', strategy: 'Income' }),
      {
        limit: 30,
        goalAccountType: 'RRSP',
        discoveryPicks: [
          pick({
            ticker: 'PSEC',
            score: 9,
            hasDividend: true,
            isUsDivPayer: true,
            incomeYield: 0.131,
            incomeYieldSource: 'metrics',
          }),
          pick({
            ticker: 'QTRLY',
            score: 10,
            hasDividend: true,
            isUsDivPayer: true,
          }),
        ],
      },
      NOW,
    );
    const tickers = recs.map((rec) => rec.security.ticker);

    assert.ok(tickers.includes('PSEC'), `approved monthly discovery pick missing: ${tickers}`);
    assert.ok(!tickers.includes('QTRLY'), `quarterly discovery pick leaked in: ${tickers}`);
    const psec = recs.find((rec) => rec.security.ticker === 'PSEC');
    assert.equal(psec?.incomeYield, 0.131);
    assert.equal(psec?.incomeYieldSource, 'metrics');
    assert.match(psec?.reason ?? '', /~13\.1% reported TTM yield/);
  });

  it('Aggressive + Income + CAD account (TFSA): Canadian covered-call ZWB/HMAX surface', () => {
    const g = goal({ type: 'Income', riskOverride: 'Aggressive' });
    const top = topTickers(g, 'TFSA', 12);
    const cdnCoveredCall = ['ZWB.TO', 'ZWU.TO', 'ZWC.TO', 'HMAX.TO', 'HDIV.TO'];
    const hits = top.filter((t) => cdnCoveredCall.includes(t));
    assert.ok(
      hits.length >= 2,
      `CAD covered-call ETFs must surface in TFSA Aggressive Income; got ${top}`,
    );
  });

  it('High + Income: adds vetted CoveredCall names but excludes Aggressive-only products', () => {
    const g = goal({ type: 'Income', riskOverride: 'High' });
    const recs = recommendSecurities(g, { limit: 30, goalAccountType: 'RRSP' }, NOW);
    const cats = new Set(recs.map((rec) => rec.security.category));
    const tickers = recs.map((rec) => rec.security.ticker);
    assert.ok(
      cats.has('CoveredCall'),
      `High Income must include vetted CoveredCall products; got ${[...cats]}`,
    );
    assert.ok(
      tickers.some((ticker) => ['JEPI', 'ZWB.TO', 'ZWU.TO', 'ZWC.TO', 'MAIN'].includes(ticker)),
      `High Income is missing its sustainable income sleeve; got ${tickers}`,
    );
    assert.ok(
      !tickers.some((ticker) => ['QQQI', 'SPYI', 'JEPQ', 'HMAX.TO', 'HDIV.TO'].includes(ticker)),
      `High Income leaked Aggressive-only products; got ${tickers}`,
    );
  });

  it('Aggressive + Growth: NO CoveredCall (growth stays growth)', () => {
    const g = goal({
      type: 'Retirement',
      targetDate: yearsFromNow(25),
      riskOverride: 'Aggressive',
      strategy: 'Growth',
    });
    const cats = categoriesOf(g);
    assert.ok(
      !cats.includes('CoveredCall'),
      `Aggressive Growth must NOT pull CoveredCall; got ${cats}`,
    );
  });

  it('NAV-erosion penalty: high-risk HDIV scores below sustainable QQQI', () => {
    const g = goal({ type: 'Income', riskOverride: 'Aggressive' });
    const recs = recommendSecurities(g, { limit: 30, goalAccountType: 'RRSP' }, NOW);
    const hdiv = recs.find((r) => r.security.ticker === 'HDIV.TO');
    const qqqi = recs.find((r) => r.security.ticker === 'QQQI');
    assert.ok(hdiv && qqqi, 'both HDIV.TO and QQQI must appear in Aggressive income recs');
    assert.ok(
      qqqi!.fitScore > hdiv!.fitScore,
      `low-erosion QQQI (${qqqi!.fitScore}) must out-rank high-erosion HDIV.TO (${hdiv!.fitScore})`,
    );
  });

  it('Aggressive non-income Retirement (no strategy): top pick stays equity, not covered-call', () => {
    const recs = recommendSecurities(
      goal({ type: 'Retirement', targetDate: yearsFromNow(25), riskOverride: 'Aggressive' }),
      { limit: 5 },
      NOW,
    );
    const top = recs[0]!;
    assert.notEqual(
      top.security.category,
      'CoveredCall',
      `Aggressive Retirement default top pick must not be covered-call; got ${top.security.ticker}`,
    );
  });

  it('blocklist: a synthetic discovery pick named MSTY is filtered out', () => {
    const g = goal({ type: 'Income', riskOverride: 'Aggressive' });
    const recs = recommendSecurities(
      g,
      {
        limit: 30,
        goalAccountType: 'RRSP',
        // MSTY is on the YieldMax blocklist. The loader filters it before it
        // ever reaches the engine, but assert the engine also never surfaces it
        // even if a caller passed it through directly.
        discoveryPicks: [pick({ ticker: 'MSTY', score: 9, hasDividend: true, isUsDivPayer: true })],
      },
      NOW,
    );
    assert.ok(
      !recs.some((r) => r.security.ticker === 'MSTY'),
      `MSTY must never appear in recommendations; got ${recs.map((r) => r.security.ticker)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// computeProgress — value summation (multi-currency, allocations), shortfall +
// required-monthly math, and the horizon-aware on-track signal.
// ---------------------------------------------------------------------------

function linked(overrides: Partial<LinkedPosition> & { positionId: number }): LinkedPosition {
  return {
    ticker: 'TEST',
    shares: 0,
    latestClose: 0,
    currency: 'CAD',
    allocation: 1,
    accountId: 1,
    accountType: 'TFSA',
    ...overrides,
  };
}

describe('computeProgress — valuation + on-track', () => {
  const USD_TO_CAD = 1.35;

  it('basic CAD position: 50 shares @ 100, target 10000 → 50% complete', () => {
    const g = goal({ type: 'Custom', targetAmountCad: 10_000, targetDate: null });
    const p = computeProgress(
      g,
      [linked({ positionId: 1, shares: 50, latestClose: 100, currency: 'CAD', allocation: 1 })],
      USD_TO_CAD,
      NOW,
    );
    assert.equal(p.currentValueCad, 5_000);
    assert.equal(p.percentComplete, 50);
    assert.equal(p.shortfallCad, 5_000);
  });

  it('USD position is converted via usdToCad', () => {
    const g = goal({ type: 'Custom', targetAmountCad: 13_500, targetDate: null });
    const p = computeProgress(
      g,
      [linked({ positionId: 1, shares: 100, latestClose: 100, currency: 'USD', allocation: 1 })],
      USD_TO_CAD,
      NOW,
    );
    // 100 * 100 USD = 10000 USD → 13500 CAD → exactly the target.
    assert.equal(p.currentValueCad, 13_500);
    assert.equal(p.percentComplete, 100);
  });

  it('multi-position sum respects per-link allocation', () => {
    const g = goal({ type: 'Custom', targetAmountCad: 10_000, targetDate: null });
    const p = computeProgress(
      g,
      [
        // 100 sh @ 50 CAD @ 50% = 2500
        linked({ positionId: 1, shares: 100, latestClose: 50, currency: 'CAD', allocation: 0.5 }),
        // 10 sh @ 100 USD @ 100% = 1000 USD → 1350 CAD
        linked({ positionId: 2, shares: 10, latestClose: 100, currency: 'USD', allocation: 1 }),
      ],
      USD_TO_CAD,
      NOW,
    );
    assert.equal(p.currentValueCad, 2_500 + 1_350);
  });

  it('zero linked positions → 0 progress, not NaN', () => {
    const g = goal({ type: 'Custom', targetAmountCad: 10_000, targetDate: null });
    const p = computeProgress(g, [], USD_TO_CAD, NOW);
    assert.equal(p.currentValueCad, 0);
    assert.equal(p.percentComplete, 0);
    assert.ok(!Number.isNaN(p.percentComplete));
  });

  it('shortfall + requiredMonthlyCad reflects remaining months', () => {
    // Target 12000, have 6000, 6 months remaining → 1000/mo.
    const g = goal({
      type: 'Custom',
      targetAmountCad: 12_000,
      targetDate: daysFromNow(182), // ~6 months
    });
    const p = computeProgress(
      g,
      [linked({ positionId: 1, shares: 60, latestClose: 100, currency: 'CAD', allocation: 1 })],
      USD_TO_CAD,
      NOW,
    );
    assert.equal(p.shortfallCad, 6_000);
    assert.equal(p.monthsRemaining, 6);
    assert.ok(p.requiredMonthlyCad !== null);
    assert.ok(
      Math.abs(p.requiredMonthlyCad! - 1_000) < 1e-6,
      `expected ~1000/mo, got ${p.requiredMonthlyCad}`,
    );
  });

  it('on-track: created 6mo ago, 5yr target, only 5% complete → behind', () => {
    // Created 6mo before NOW, target 5yr after NOW → ~9% of the horizon elapsed.
    // 5% complete is below expectedPct*0.9 (~8.2%), so the goal is behind.
    const createdAt = daysFromNow(-182);
    const targetDate = yearsFromNow(5);
    const g = goal({ type: 'Custom', targetAmountCad: 10_000, targetDate, createdAt });
    const p = computeProgress(
      g,
      // 5 sh @ 100 CAD = 500 → 5% of 10000
      [linked({ positionId: 1, shares: 5, latestClose: 100, currency: 'CAD', allocation: 1 })],
      USD_TO_CAD,
      NOW,
    );
    assert.equal(p.percentComplete, 5);
    assert.equal(p.onTrack, false);
  });

  it('on-track: created 6mo ago, 5yr target, well ahead of pace → on track', () => {
    const createdAt = daysFromNow(-182);
    const targetDate = yearsFromNow(5);
    const g = goal({ type: 'Custom', targetAmountCad: 10_000, targetDate, createdAt });
    const p = computeProgress(
      g,
      // 30 sh @ 100 CAD = 3000 → 30% complete, far above the ~9% expected.
      [linked({ positionId: 1, shares: 30, latestClose: 100, currency: 'CAD', allocation: 1 })],
      USD_TO_CAD,
      NOW,
    );
    assert.equal(p.percentComplete, 30);
    assert.equal(p.onTrack, true);
  });

  it('on-track: open-ended goal (no targetDate) is always on track', () => {
    const g = goal({ type: 'Retirement', targetAmountCad: 1_000_000, targetDate: null });
    const p = computeProgress(g, [], USD_TO_CAD, NOW);
    assert.equal(p.monthsRemaining, null);
    assert.equal(p.requiredMonthlyCad, null);
    assert.equal(p.onTrack, true);
  });

  it('on-track: createdAt at/after targetDate → expected 100%, behind unless complete', () => {
    const createdAt = yearsFromNow(1);
    const targetDate = NOW; // created after target — full horizon elapsed
    const g = goal({ type: 'Custom', targetAmountCad: 10_000, targetDate, createdAt });
    const behind = computeProgress(
      g,
      [linked({ positionId: 1, shares: 50, latestClose: 100, currency: 'CAD', allocation: 1 })], // 50%
      USD_TO_CAD,
      NOW,
    );
    assert.equal(behind.onTrack, false);
    const done = computeProgress(
      g,
      [linked({ positionId: 1, shares: 100, latestClose: 100, currency: 'CAD', allocation: 1 })], // 100%
      USD_TO_CAD,
      NOW,
    );
    assert.equal(done.onTrack, true);
  });

  it('on-track: missing createdAt falls back to now → expectedPct 0 → on track', () => {
    const g = goal({ type: 'Custom', targetAmountCad: 10_000, targetDate: yearsFromNow(5) });
    const p = computeProgress(g, [], USD_TO_CAD, NOW);
    // No createdAt supplied and $0 saved: fallback yields expectedPct 0, so the
    // badge never falsely reports "behind".
    assert.equal(p.percentComplete, 0);
    assert.equal(p.onTrack, true);
  });
});

describe('recommendAccount — DayTrading (inverted account logic)', () => {
  function acct(
    overrides: Partial<AccountSummary> & { id: number; type: AccountSummary['type'] },
  ): AccountSummary {
    return {
      currency: 'CAD',
      contributionRoomCad: null,
      currentValueCad: 0,
      archived: false,
      ...overrides,
    };
  }

  it('ranks Personal then Margin ONLY — registered accounts are excluded', () => {
    const g = goal({ type: 'DayTrading', targetAmountCad: 25_000, targetDate: null });
    const rec = recommendAccount(g, [], NOW);
    assert.deepEqual(rec.rankedTypes, ['Personal', 'Margin']);
    assert.ok(!rec.rankedTypes.includes('TFSA'));
    assert.ok(!rec.rankedTypes.includes('RRSP'));
    // Rationale must distinguish the two regimes (audit Finding 1): TFSA is
    // exposed to business-income reclassification; RRSP is NOT (s.146(4)(b)) —
    // its real downside is withdrawal tax + lost room. It must NOT claim the
    // RRSP can be reclassified.
    assert.match(rec.rationale, /business income/i);
    assert.match(rec.rationale, /TFSA can be\s+reclassified/i);
    assert.match(rec.rationale, /RRSPs? (are|is) exempt/i);
    assert.match(rec.rationale, /destroy contribution\s+room/i);
    assert.doesNotMatch(rec.rationale, /TFSA\/RRSP/);
  });

  it('picks the Personal account when the user has one (no warning)', () => {
    const g = goal({ type: 'DayTrading', targetAmountCad: 25_000, targetDate: null });
    const accounts = [
      acct({ id: 1, type: 'RRSP' }),
      acct({ id: 2, type: 'Personal' }),
      acct({ id: 3, type: 'Margin' }),
    ];
    const rec = recommendAccount(g, accounts, NOW);
    assert.equal(rec.bestAccountId, 2, 'should pick the Personal account');
    assert.equal(rec.warning, undefined, 'no warning when a non-registered account exists');
  });

  it('prefers Personal over Margin when both exist', () => {
    const g = goal({ type: 'DayTrading', targetAmountCad: 25_000, targetDate: null });
    const accounts = [acct({ id: 5, type: 'Margin' }), acct({ id: 6, type: 'Personal' })];
    const rec = recommendAccount(g, accounts, NOW);
    assert.equal(rec.bestAccountId, 6);
  });

  it('HARD WARNS when the user only has registered accounts (the RRSP-only case)', () => {
    const g = goal({ type: 'DayTrading', targetAmountCad: 25_000, targetDate: null });
    // Mirrors the live "US Gambling" RRSP-only scenario.
    const accounts = [acct({ id: 1, type: 'RRSP' })];
    const rec = recommendAccount(g, accounts, NOW);
    assert.ok(rec.warning, 'expected a hard warning');
    assert.match(rec.warning!, /no non-registered account/i);
    assert.match(rec.warning!, /CRA business-income reclassification/i);
    assert.match(rec.warning!, /Personal\/Margin/);
    // Still surfaces the least-bad concrete account so the page has something to point at.
    assert.equal(rec.bestAccountId, 1);
  });

  it('warns when only TFSA + RRSP exist (both registered)', () => {
    const g = goal({ type: 'DayTrading', targetAmountCad: 25_000, targetDate: null });
    const accounts = [acct({ id: 1, type: 'TFSA' }), acct({ id: 2, type: 'RRSP' })];
    const rec = recommendAccount(g, accounts, NOW);
    assert.ok(rec.warning, 'TFSA+RRSP only must warn');
  });
});

describe('recommendSecurities — DayTrading bypass', () => {
  it('returns no curated buy-and-hold picks for a DayTrading goal', () => {
    const g = goal({ type: 'DayTrading', targetAmountCad: 25_000, targetDate: null });
    const recs = recommendSecurities(g, { limit: 10 }, NOW);
    assert.equal(recs.length, 0, 'DayTrading must bypass the curated pool');
  });
});
