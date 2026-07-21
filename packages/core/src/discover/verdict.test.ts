/**
 * Verdict unit tests.
 *
 * Runs on node:test (stdlib) to avoid adding a test framework dep. Every
 * branch of computeVerdict has at least one fixture.
 *
 * Run with:
 *   pnpm --filter @vantage/core build && \
 *   node --test packages/core/dist/discover/verdict.test.js
 *
 * (The test file is compiled as part of the core tsc build.)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeVerdict, type VerdictInput } from './verdict.js';
import {
  computeDiscoveryScore,
  DEFAULT_WEIGHTS,
  balanceSheetScore,
  epsGrowthScore,
  liquidityScore,
  marginScore,
  profitabilityScore,
  revenueGrowthScore,
  sizeScore,
  valuationScore,
  type ComputeDiscoveryScoreInput,
  type SignalBreakdown,
  type TickerMetricsLike,
} from './signals.js';

function breakdown(overrides: Partial<SignalBreakdown> = {}): SignalBreakdown {
  return {
    news: 0,
    earnings: 0,
    insider: 0,
    filings: 0,
    momentum: 0,
    sentiment: 0,
    epsGrowth: 0,
    revenueGrowth: 0,
    margins: 0,
    valuation: 0,
    profitability: 0,
    balanceSheet: 0,
    liquidity: 0,
    size: 0,
    ...overrides,
  };
}

describe('computeVerdict — held', () => {
  it('EXIT when thesis is Broken', () => {
    const input: VerdictInput = {
      held: true,
      score: 0.1,
      thesisStatus: 'Broken',
      recentReturnPct: 0,
      positionWeightPct: 5,
      singlePositionCapPct: 15,
    };
    const v = computeVerdict(input);
    assert.equal(v.kind, 'EXIT');
    assert.equal(v.tone, 'rose');
  });

  it('TRIM when Weakening + 30d return < -10%', () => {
    const input: VerdictInput = {
      held: true,
      score: -0.1,
      thesisStatus: 'Weakening',
      recentReturnPct: -15.2,
      positionWeightPct: 8,
      singlePositionCapPct: 15,
    };
    const v = computeVerdict(input);
    assert.equal(v.kind, 'TRIM');
    assert.equal(v.tone, 'amber');
  });

  it('WATCH when Weakening but 30d return is holding up', () => {
    const input: VerdictInput = {
      held: true,
      score: 0.05,
      thesisStatus: 'Weakening',
      recentReturnPct: -3.0,
      positionWeightPct: 8,
      singlePositionCapPct: 15,
    };
    const v = computeVerdict(input);
    assert.equal(v.kind, 'WATCH');
    assert.equal(v.tone, 'amber');
  });

  it('ADD when Strengthening and weight below 80% of cap', () => {
    const input: VerdictInput = {
      held: true,
      score: 0.55,
      thesisStatus: 'Strengthening',
      recentReturnPct: 6.0,
      positionWeightPct: 8, // 8 < 12 (0.8 * 15)
      singlePositionCapPct: 15,
    };
    const v = computeVerdict(input);
    assert.equal(v.kind, 'ADD');
    assert.equal(v.tone, 'emerald');
  });

  it('HOLD+ when Strengthening but already near cap', () => {
    const input: VerdictInput = {
      held: true,
      score: 0.55,
      thesisStatus: 'Strengthening',
      recentReturnPct: 6.0,
      positionWeightPct: 13.5, // 13.5 >= 12 (0.8 * 15)
      singlePositionCapPct: 15,
    };
    const v = computeVerdict(input);
    assert.equal(v.kind, 'HOLD+');
    assert.equal(v.tone, 'emerald');
  });

  it('HOLD when Intact', () => {
    const input: VerdictInput = {
      held: true,
      score: 0.2,
      thesisStatus: 'Intact',
      recentReturnPct: 2.0,
      positionWeightPct: 8,
      singlePositionCapPct: 15,
    };
    const v = computeVerdict(input);
    assert.equal(v.kind, 'HOLD');
    assert.equal(v.tone, 'zinc');
  });

  it('NEEDS THESIS when no thesis on file', () => {
    const input: VerdictInput = {
      held: true,
      score: 0.4,
      thesisStatus: null,
      recentReturnPct: 0,
      positionWeightPct: 10,
      singlePositionCapPct: 15,
    };
    const v = computeVerdict(input);
    assert.equal(v.kind, 'NEEDS THESIS');
    assert.equal(v.tone, 'zinc');
  });

  it('Strengthening with missing cap data falls back to HOLD+', () => {
    // We treat missing sizing data as "can't confirm room to grow".
    const input: VerdictInput = {
      held: true,
      score: 0.55,
      thesisStatus: 'Strengthening',
      recentReturnPct: 6.0,
      positionWeightPct: null,
      singlePositionCapPct: null,
    };
    const v = computeVerdict(input);
    assert.equal(v.kind, 'HOLD+');
  });
});

describe('computeVerdict — unheld', () => {
  it('BUY when score ≥ 6 + news coverage + earnings beat', () => {
    const input: VerdictInput = {
      held: false,
      score: 7.2,
      breakdown: breakdown({ news: 6, earnings: 0.4 }),
    };
    const v = computeVerdict(input);
    assert.equal(v.kind, 'BUY');
    assert.equal(v.tone, 'emerald');
  });

  it('BUY when score ≥ 6 + news coverage + insider buys', () => {
    const input: VerdictInput = {
      held: false,
      score: 6.1,
      breakdown: breakdown({ news: 4, insider: 0.5 }),
    };
    const v = computeVerdict(input);
    assert.equal(v.kind, 'BUY');
  });

  it('WATCH when score ≥ 6 but confirming signals are thin', () => {
    const input: VerdictInput = {
      held: false,
      score: 6.5,
      breakdown: breakdown({ news: 0, earnings: 0, insider: 0 }),
    };
    const v = computeVerdict(input);
    assert.equal(v.kind, 'WATCH');
    assert.equal(v.tone, 'amber');
  });

  it('WATCH when score is between 3 and 6', () => {
    const input: VerdictInput = {
      held: false,
      score: 4.2,
      breakdown: breakdown({ news: 3 }),
    };
    const v = computeVerdict(input);
    assert.equal(v.kind, 'WATCH');
    assert.equal(v.tone, 'amber');
  });

  it('MONITOR when score is between 0 and 3', () => {
    const input: VerdictInput = {
      held: false,
      score: 1.2,
      breakdown: breakdown({ news: 1 }),
    };
    const v = computeVerdict(input);
    assert.equal(v.kind, 'MONITOR');
    assert.equal(v.tone, 'zinc');
  });

  it('AVOID when score < 0', () => {
    const input: VerdictInput = {
      held: false,
      score: -0.22,
      breakdown: breakdown({ news: 4, sentiment: -0.3 }),
    };
    const v = computeVerdict(input);
    assert.equal(v.kind, 'AVOID');
    assert.equal(v.tone, 'rose');
  });

  it('AVOID when score < 0 even with null breakdown', () => {
    const input: VerdictInput = {
      held: false,
      score: -0.05,
      breakdown: null,
    };
    const v = computeVerdict(input);
    assert.equal(v.kind, 'AVOID');
  });
});

// ---------------------------------------------------------------------------
// Fundamentals signal scores
// ---------------------------------------------------------------------------

describe('epsGrowthScore', () => {
  it('returns 0 for null metrics', () => {
    assert.equal(epsGrowthScore(null), 0);
    assert.equal(epsGrowthScore(undefined), 0);
    assert.equal(epsGrowthScore({}), 0);
  });

  it('scores high when both YoY and 5y are strong', () => {
    const s = epsGrowthScore({ epsGrowthYoy: 0.3, epsGrowth5y: 0.2 });
    assert.ok(s >= 8, `expected >=8, got ${s}`);
    assert.ok(s <= 10);
  });

  it('scores low when growth is negative', () => {
    const s = epsGrowthScore({ epsGrowthYoy: -0.2, epsGrowth5y: -0.05 });
    assert.equal(s, 0);
  });
});

describe('revenueGrowthScore', () => {
  it('returns 0 for null metrics', () => {
    assert.equal(revenueGrowthScore(null), 0);
    assert.equal(revenueGrowthScore({}), 0);
  });

  it('scores high for strong durable growth', () => {
    const s = revenueGrowthScore({ revenueGrowthYoy: 0.25, revenueGrowth5y: 0.15 });
    assert.ok(s >= 8);
  });

  it('scores low for negative growth', () => {
    const s = revenueGrowthScore({ revenueGrowthYoy: -0.1, revenueGrowth5y: -0.02 });
    assert.equal(s, 0);
  });
});

describe('marginScore', () => {
  it('returns 0 for null metrics', () => {
    assert.equal(marginScore(null), 0);
    assert.equal(marginScore({}), 0);
  });

  it('scores high for best-in-class margins', () => {
    const s = marginScore({
      grossMarginTtm: 0.6,
      operatingMarginTtm: 0.25,
      netMarginTtm: 0.2,
    });
    assert.ok(s >= 9);
  });

  it('scores low for negative margins', () => {
    const s = marginScore({
      grossMarginTtm: -0.1,
      operatingMarginTtm: -0.2,
      netMarginTtm: -0.3,
    });
    assert.equal(s, 0);
  });
});

describe('valuationScore', () => {
  it('returns 0 for null metrics', () => {
    assert.equal(valuationScore(null), 0);
    assert.equal(valuationScore({}), 0);
  });

  it('scores high for cheap multiples', () => {
    const s = valuationScore({ peTtm: 12, psTtm: 1.2 });
    assert.ok(s >= 8);
  });

  it('scores 0 for negative or extreme P/E', () => {
    assert.equal(valuationScore({ peTtm: -5, psTtm: -1 }), 0);
    assert.equal(valuationScore({ peTtm: 200, psTtm: 100 }), 0);
  });

  it('scores low for very expensive multiples', () => {
    const s = valuationScore({ peTtm: 80, psTtm: 25 });
    assert.ok(s <= 2);
  });
});

describe('profitabilityScore', () => {
  it('returns 0 for null metrics', () => {
    assert.equal(profitabilityScore(null), 0);
    assert.equal(profitabilityScore({}), 0);
  });

  it('scores high for best-in-class returns', () => {
    const s = profitabilityScore({ roeTtm: 0.25, roicTtm: 0.18, roaTtm: 0.12 });
    assert.ok(s >= 9);
  });

  it('scores 0 for negative returns', () => {
    const s = profitabilityScore({ roeTtm: -0.1, roicTtm: -0.05, roaTtm: -0.03 });
    assert.equal(s, 0);
  });
});

describe('balanceSheetScore', () => {
  it('returns 0 for null metrics', () => {
    assert.equal(balanceSheetScore(null), 0);
    assert.equal(balanceSheetScore({}), 0);
  });

  it('scores high for healthy balance sheet', () => {
    const s = balanceSheetScore({ debtToEquity: 0.2, currentRatio: 2.0 });
    assert.ok(s >= 9);
  });

  it('scores low for over-leveraged firm with weak liquidity', () => {
    const s = balanceSheetScore({ debtToEquity: 4.0, currentRatio: 0.5 });
    assert.ok(s <= 3);
  });
});

describe('liquidityScore', () => {
  it('returns 0 for null metrics', () => {
    assert.equal(liquidityScore(null), 0);
    assert.equal(liquidityScore({}), 0);
    assert.equal(liquidityScore({ avgDollarVolume30d: 0 }), 0);
  });

  it('scores high for $100M+ avg daily volume', () => {
    const s = liquidityScore({ avgDollarVolume30d: 200_000_000 });
    assert.ok(s >= 9);
  });

  it('scores low for sub-$1M avg daily volume', () => {
    const s = liquidityScore({ avgDollarVolume30d: 50_000 });
    assert.equal(s, 0);
  });
});

describe('sizeScore', () => {
  it('returns 0 for null metrics', () => {
    assert.equal(sizeScore(null), 0);
    assert.equal(sizeScore({}), 0);
  });

  it('saturates at $1B+ market cap', () => {
    const s = sizeScore({ marketCapUsd: 50_000_000_000 });
    assert.equal(s, 10);
  });

  it('scores low for micro-caps', () => {
    const s = sizeScore({ marketCapUsd: 50_000_000 });
    assert.equal(s, 0);
  });
});

// ---------------------------------------------------------------------------
// Composite + weights sanity
// ---------------------------------------------------------------------------

describe('DEFAULT_WEIGHTS', () => {
  it('sums to 1.0 within floating-point tolerance', () => {
    const total = Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 1.0) < 1e-9, `weights sum was ${total}`);
  });
});

describe('computeDiscoveryScore', () => {
  it('produces a sane composite in roughly [0, 10] for healthy fundamentals', () => {
    const metrics: TickerMetricsLike = {
      peTtm: 15,
      psTtm: 2,
      roeTtm: 0.22,
      roicTtm: 0.16,
      roaTtm: 0.1,
      grossMarginTtm: 0.55,
      operatingMarginTtm: 0.22,
      netMarginTtm: 0.18,
      debtToEquity: 0.4,
      currentRatio: 1.8,
      revenueGrowthYoy: 0.2,
      revenueGrowth5y: 0.13,
      epsGrowthYoy: 0.25,
      epsGrowth5y: 0.16,
      marketCapUsd: 20_000_000_000,
      avgDollarVolume30d: 50_000_000,
    };
    const input: ComputeDiscoveryScoreInput = {
      articles: [],
      earningsEvents: [],
      insiderTxns: [],
      filings8K: [],
      recentBars: [],
      sectorAvgReturn: 0,
      tier3Articles: [],
      metrics,
    };
    const { score, breakdown: bd } = computeDiscoveryScore(input);
    assert.ok(score >= 0 && score <= 10, `score out of range: ${score}`);
    // With strong fundamentals across the board, fundamentals weights (~0.65)
    // times near-saturated sub-scores should land us above 5.
    assert.ok(score >= 5, `expected strong score, got ${score}`);
    assert.ok(bd.epsGrowth >= 8);
    assert.ok(bd.profitability >= 9);
  });

  it('handles null metrics without throwing and returns near-zero composite', () => {
    const input: ComputeDiscoveryScoreInput = {
      articles: [],
      earningsEvents: [],
      insiderTxns: [],
      filings8K: [],
      recentBars: [],
      sectorAvgReturn: 0,
      tier3Articles: [],
      metrics: null,
    };
    const { score, breakdown: bd } = computeDiscoveryScore(input);
    assert.equal(bd.epsGrowth, 0);
    assert.equal(bd.valuation, 0);
    assert.ok(score >= -1 && score <= 10);
  });
});
