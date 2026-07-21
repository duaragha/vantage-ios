/**
 * Day-trade scanner unit tests — pure math (ATR%, RSI), the style-weighting
 * fitScore, and the liquidity-floor / ATR-floor contracts.
 *
 * Run with:
 *   pnpm --filter @vantage/core build && \
 *   node --test packages/core/dist/goals/dayTradeScanner.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeAtrPct,
  computeRsi,
  computeTradePlan,
  scoreCandidate,
  selectActionableCandidates,
  selectDisplayPrice,
  type DayTradeCandidate,
  type TradePlan,
} from './dayTradeScanner.js';

function bar(o: number, h: number, l: number, c: number, v = 1_000_000) {
  return { date: new Date(), open: o, high: h, low: l, close: c, volume: v };
}

// A flat 10-bar window with high=102, low=98 every bar, last close = 100. Gives
// a deterministic 10-bar high of 102 and low of 98 for plan-level assertions.
function flatWindow(close = 100, high = 102, low = 98) {
  return Array.from({ length: 10 }, () => bar(close, high, low, close));
}

describe('computeAtrPct', () => {
  it('computes 14-period ATR as a percentage of the latest close', () => {
    // Flat $100 stock with a constant $2 daily range and no gaps → TR = 2 each
    // bar, ATR = 2, ATR% = 2/100 = 2%.
    const bars = Array.from({ length: 16 }, () => bar(100, 101, 99, 100));
    const atr = computeAtrPct(bars);
    assert.ok(atr !== null);
    assert.ok(Math.abs(atr! - 2) < 1e-6, `expected ~2%, got ${atr}`);
  });

  it('accounts for gaps via |high-prevClose| / |low-prevClose|', () => {
    // Two bars: prevClose 100, next bar gaps up to a 105-107 range. TR for the
    // second bar = max(107-105, |107-100|, |105-100|) = 7. ATR%=7/106≈6.6%.
    const bars = [bar(100, 100, 100, 100), bar(106, 107, 105, 106)];
    const atr = computeAtrPct(bars);
    assert.ok(atr !== null);
    assert.ok(Math.abs(atr! - (7 / 106) * 100) < 1e-6, `got ${atr}`);
  });

  it('returns null with fewer than 2 bars', () => {
    assert.equal(computeAtrPct([bar(100, 101, 99, 100)]), null);
    assert.equal(computeAtrPct([]), null);
  });

  it('returns null when the latest close is non-positive', () => {
    const bars = [bar(1, 1, 1, 1), bar(0, 0, 0, 0)];
    assert.equal(computeAtrPct(bars), null);
  });

  it('returns 0 for a perfectly constant-price ticker (no range, no gaps)', () => {
    // close == high == low every bar → TR 0 each → ATR 0 → ATR% 0. The scanner's
    // MIN_ATR_PCT gate then filters it; here we just confirm no NaN/crash.
    const bars = Array.from({ length: 15 }, () => bar(50, 50, 50, 50));
    assert.equal(computeAtrPct(bars), 0);
  });
});

describe('computeRsi', () => {
  it('returns 100 for an unbroken uptrend (no losses)', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
    assert.equal(computeRsi(closes), 100);
  });

  it('returns a low RSI for an unbroken downtrend', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 - i);
    const rsi = computeRsi(closes);
    assert.ok(rsi !== null && rsi < 5, `expected oversold, got ${rsi}`);
  });

  it('returns null with insufficient data', () => {
    assert.equal(computeRsi([100, 101, 102]), null);
  });
});

describe('scoreCandidate — style weighting', () => {
  const liquid = 50_000_000; // $50M/day

  it('Momentum rewards high RVOL + catalyst + positive return over a quiet name', () => {
    const hot = scoreCandidate(
      'Momentum',
      {
        atrPct: 5,
        relativeVolume: 4,
        avgDollarVolume: liquid,
        rsi: 60,
        recentRet: 0.08,
        rangeHighFrac: 0.98,
        hasCatalyst: true,
      },
      'earnings beat 2d ago',
    );
    const quiet = scoreCandidate(
      'Momentum',
      {
        atrPct: 2.1,
        relativeVolume: 1,
        avgDollarVolume: liquid,
        rsi: 50,
        recentRet: 0,
        rangeHighFrac: 0.6,
        hasCatalyst: false,
      },
      null,
    );
    assert.ok(hot.fit > quiet.fit, `momentum hot(${hot.fit}) should beat quiet(${quiet.fit})`);
    assert.match(hot.reason, /momentum setup/);
    assert.match(hot.reason, /earnings beat/);
  });

  it('ORB weights ATR% — a higher-ATR name outscores a low-ATR one at equal liquidity', () => {
    const wide = scoreCandidate(
      'ORB',
      {
        atrPct: 7,
        relativeVolume: 2,
        avgDollarVolume: liquid,
        rsi: 50,
        recentRet: 0,
        rangeHighFrac: 0.5,
        hasCatalyst: false,
      },
      null,
    );
    const narrow = scoreCandidate(
      'ORB',
      {
        atrPct: 2.2,
        relativeVolume: 2,
        avgDollarVolume: liquid,
        rsi: 50,
        recentRet: 0,
        rangeHighFrac: 0.5,
        hasCatalyst: false,
      },
      null,
    );
    assert.ok(wide.fit > narrow.fit, `ORB wide(${wide.fit}) should beat narrow(${narrow.fit})`);
  });

  it('MeanReversion rewards RSI extremes', () => {
    const oversold = scoreCandidate(
      'MeanReversion',
      {
        atrPct: 5,
        relativeVolume: 1,
        avgDollarVolume: liquid,
        rsi: 22,
        recentRet: -0.1,
        rangeHighFrac: 0.5,
        hasCatalyst: false,
      },
      null,
    );
    const neutral = scoreCandidate(
      'MeanReversion',
      {
        atrPct: 5,
        relativeVolume: 1,
        avgDollarVolume: liquid,
        rsi: 50,
        recentRet: 0,
        rangeHighFrac: 0.5,
        hasCatalyst: false,
      },
      null,
    );
    assert.ok(
      oversold.fit > neutral.fit,
      `oversold(${oversold.fit}) should beat neutral(${neutral.fit})`,
    );
    assert.match(oversold.reason, /oversold/);
  });

  it('Scalping is liquidity-dominated and carries an honest losing-odds note', () => {
    const deep = scoreCandidate(
      'Scalping',
      {
        atrPct: 3,
        relativeVolume: 2,
        avgDollarVolume: 100_000_000,
        rsi: 50,
        recentRet: 0,
        rangeHighFrac: 0.5,
        hasCatalyst: false,
      },
      null,
    );
    const shallow = scoreCandidate(
      'Scalping',
      {
        atrPct: 3,
        relativeVolume: 2,
        avgDollarVolume: 6_000_000,
        rsi: 50,
        recentRet: 0,
        rangeHighFrac: 0.5,
        hasCatalyst: false,
      },
      null,
    );
    assert.ok(
      deep.fit > shallow.fit,
      `deep liquidity(${deep.fit}) should beat shallow(${shallow.fit})`,
    );
    assert.match(deep.reason, /most scalpers lose/);
  });

  it('Breakout rewards proximity to the range high', () => {
    const atHigh = scoreCandidate(
      'Breakout',
      {
        atrPct: 4,
        relativeVolume: 3,
        avgDollarVolume: liquid,
        rsi: 60,
        recentRet: 0.03,
        rangeHighFrac: 1.0,
        hasCatalyst: false,
      },
      null,
    );
    const midRange = scoreCandidate(
      'Breakout',
      {
        atrPct: 4,
        relativeVolume: 3,
        avgDollarVolume: liquid,
        rsi: 60,
        recentRet: 0.03,
        rangeHighFrac: 0.7,
        hasCatalyst: false,
      },
      null,
    );
    assert.ok(
      atHigh.fit > midRange.fit,
      `atHigh(${atHigh.fit}) should beat midRange(${midRange.fit})`,
    );
  });

  it('clamps fitScore to 0..100', () => {
    const maxed = scoreCandidate(
      'Momentum',
      {
        atrPct: 50,
        relativeVolume: 20,
        avgDollarVolume: 1e9,
        rsi: 90,
        recentRet: 5,
        rangeHighFrac: 1,
        hasCatalyst: true,
      },
      'earnings beat today',
    );
    assert.ok(maxed.fit >= 0 && maxed.fit <= 100, `fit out of range: ${maxed.fit}`);
  });

  it('Scalping ranks a $22B mega-cap above a $113M mid-cap (log-scaled liquidity)', () => {
    // Regression for the saturated-liquidity bug: both clear the floor and a
    // linear clamp at $15M tied them. A genuinely deeper book must now win even
    // when the mid-cap has the higher ATR (scalpers want liquidity, not range).
    const mega = scoreCandidate(
      'Scalping',
      {
        atrPct: 4.3,
        relativeVolume: 1,
        avgDollarVolume: 22_500_000_000,
        rsi: 50,
        recentRet: 0,
        rangeHighFrac: 0.5,
        hasCatalyst: false,
      },
      null,
    );
    const mid = scoreCandidate(
      'Scalping',
      {
        atrPct: 7,
        relativeVolume: 1,
        avgDollarVolume: 113_000_000,
        rsi: 50,
        recentRet: 0,
        rangeHighFrac: 0.5,
        hasCatalyst: false,
      },
      null,
    );
    assert.ok(mega.fit > mid.fit, `mega-cap(${mega.fit}) should outrank mid-cap(${mid.fit})`);
  });

  it('ORB liquidity actually varies across the realistic range (not a constant)', () => {
    // Same ATR/RVOL, different liquidity → different fit. Before the log-scale
    // fix both saturated to the same constant 25 liquidity term.
    const deep = scoreCandidate(
      'ORB',
      {
        atrPct: 5,
        relativeVolume: 2,
        avgDollarVolume: 5_000_000_000,
        rsi: 50,
        recentRet: 0,
        rangeHighFrac: 0.5,
        hasCatalyst: false,
      },
      null,
    );
    const thin = scoreCandidate(
      'ORB',
      {
        atrPct: 5,
        relativeVolume: 2,
        avgDollarVolume: 20_000_000,
        rsi: 50,
        recentRet: 0,
        rangeHighFrac: 0.5,
        hasCatalyst: false,
      },
      null,
    );
    assert.ok(deep.fit > thin.fit, `deep(${deep.fit}) should beat thin(${thin.fit}) on liquidity`);
  });
});

describe('computeTradePlan — stop / target / size math', () => {
  it('Momentum: ATR-based stop distance, 2:1 target, 1%-risk share count', () => {
    // anchor 100, ATR 4% → ATR$ = 4. Momentum stop = 1.5× ATR = 6.
    // No intraday levels → EOD fallback: entry = max(10-day high 102, anchor 100) = 102.
    const plan = computeTradePlan({
      style: 'Momentum',
      anchor: 100,
      atrPct: 4,
      capital: 10_000,
      bars: flatWindow(100, 102, 98),
    });
    assert.ok(plan !== null);
    assert.equal(plan!.entry, 102, 'entry = 10-day high (EOD fallback, break of high)');
    assert.equal(plan!.stopAtrMult, 1.5, 'momentum uses a 1.5× ATR stop');
    // stop = entry − 1.5×ATR$ = 102 − 6 = 96; distance = 6.
    assert.equal(plan!.stop, 96);
    assert.equal(plan!.stopDistance, 6);
    // 2:1 target = entry + 2×distance = 102 + 12 = 114.
    assert.equal(plan!.rewardRiskRatio, 2);
    assert.equal(plan!.target, 114);
    // size: riskPerTrade = 1% × 10000 = 100; shares = floor(100/6) = 16.
    assert.equal(plan!.riskPerTrade, 100);
    assert.equal(plan!.shares, 16);
    assert.equal(plan!.positionValue, 16 * 102);
    // actual $ risk after rounding = 16 × 6 = 96 (≤ riskPerTrade).
    assert.equal(plan!.dollarRisk, 96);
    assert.ok(plan!.dollarRisk <= plan!.riskPerTrade);
  });

  it('stopPct is the stop distance as a percent of entry', () => {
    const plan = computeTradePlan({
      style: 'Momentum',
      anchor: 100,
      atrPct: 4,
      capital: 10_000,
      bars: flatWindow(100, 102, 98),
    });
    assert.ok(plan !== null);
    // distance 6 on entry 102 → 5.882%, rounded to 2 dp = 5.88.
    assert.equal(plan!.stopPct, 5.88);
  });

  it('a tighter stop (smaller ATR mult) buys more shares for the same risk', () => {
    // MeanReversion uses a 1.0× ATR stop vs Momentum's 1.5× — tighter → more shares.
    const wide = computeTradePlan({
      style: 'Momentum',
      anchor: 100,
      atrPct: 4,
      capital: 10_000,
      bars: flatWindow(100, 100, 98), // high=100 so entry=anchor=100, isolating the stop mult
    });
    const tight = computeTradePlan({
      style: 'MeanReversion',
      anchor: 100,
      atrPct: 4,
      capital: 10_000,
      bars: flatWindow(100, 100, 98),
    });
    assert.ok(wide !== null && tight !== null);
    assert.ok(
      tight!.shares > wide!.shares,
      `tighter stop should size larger: tight(${tight!.shares}) vs wide(${wide!.shares})`,
    );
  });

  it('position size scales with capital (double capital → ~double shares)', () => {
    const small = computeTradePlan({
      style: 'Momentum',
      anchor: 100,
      atrPct: 4,
      capital: 10_000,
      bars: flatWindow(),
    });
    const big = computeTradePlan({
      style: 'Momentum',
      anchor: 100,
      atrPct: 4,
      capital: 20_000,
      bars: flatWindow(),
    });
    assert.ok(small !== null && big !== null);
    // floor() doesn't distribute exactly over doubling, so allow ±1 share.
    assert.ok(
      Math.abs(big!.shares - small!.shares * 2) <= 1,
      `expected ~2× shares: small ${small!.shares}, big ${big!.shares}`,
    );
    assert.ok(big!.shares > small!.shares);
  });

  it('converts a USD stop into CAD before applying the 1% risk budget', () => {
    const plan = computeTradePlan({
      style: 'Momentum',
      anchor: 100,
      atrPct: 4,
      capital: 10_000,
      currency: 'USD',
      nativeToCadRate: 1.36,
      bars: flatWindow(100, 102, 98),
    });
    assert.ok(plan !== null);
    // The $6 USD stop is C$8.16 per share. C$100 / C$8.16 floors to 12.
    assert.equal(plan!.shares, 12);
    assert.equal(plan!.riskPerTrade, 100);
    assert.equal(plan!.dollarRisk, 97.92);
    assert.equal(plan!.positionValue, 1664.64);
    assert.equal(plan!.nativeToCadRate, 1.36);
  });

  it('returns shares = 0 when one share risks more than the 1% budget', () => {
    // $1000 capital → $10 risk budget. A $500 stock with a 6% ATR → 1.5× stop ≈ $45 risk/share.
    const plan = computeTradePlan({
      style: 'Momentum',
      anchor: 500,
      atrPct: 6,
      capital: 1_000,
      bars: flatWindow(500, 500, 470),
    });
    assert.ok(plan !== null);
    assert.equal(plan!.shares, 0);
    assert.equal(plan!.positionValue, 0);
    assert.equal(plan!.dollarRisk, 0);
  });

  it("MeanReversion enters near TODAY's low (fade), not at a high breakout", () => {
    const plan = computeTradePlan({
      style: 'MeanReversion',
      anchor: 100,
      atrPct: 4,
      capital: 10_000,
      bars: flatWindow(100, 102, 88),
      intraday: { high: 103, low: 90, open: 98 }, // today's low = 90
    });
    assert.ok(plan !== null);
    // entry = min(anchor, today's low + 0.5×ATR$) = min(100, 90+2) = 92.
    assert.equal(plan!.entry, 92);
    assert.match(plan!.entryCondition, /Bounce entry/);
    assert.match(plan!.entryCondition, /today's low/);
  });

  it('Scalping keeps the honest losing-odds caveat in the entry condition', () => {
    const plan = computeTradePlan({
      style: 'Scalping',
      anchor: 50,
      atrPct: 3,
      capital: 5_000,
      bars: flatWindow(50, 51, 49),
    });
    assert.ok(plan !== null);
    assert.match(plan!.entryCondition, /most scalpers lose/);
  });

  it('returns null when ATR% or anchor is non-positive', () => {
    assert.equal(
      computeTradePlan({
        style: 'Momentum',
        anchor: 0,
        atrPct: 4,
        capital: 10_000,
        bars: flatWindow(),
      }),
      null,
    );
    assert.equal(
      computeTradePlan({
        style: 'Momentum',
        anchor: 100,
        atrPct: 0,
        capital: 10_000,
        bars: flatWindow(),
      }),
      null,
    );
  });
});

describe('computeTradePlan — live vs EOD anchor preference', () => {
  // scanDayTradeCandidates anchors the plan to the live price when a fresh
  // LivePrice row exists, else the latest EOD close. The plan math is purely a
  // function of the anchor, so passing the live price vs the close shifts every
  // level proportionally — this is the load-bearing behavior of the fallback.
  it('a live anchor keys the plan to the live price (preferred over EOD close)', () => {
    const lastClose = 100;
    const livePrice = 110; // up 10% intraday
    const eodPlan = computeTradePlan({
      style: 'Scalping',
      anchor: lastClose,
      atrPct: 4,
      capital: 10_000,
      bars: flatWindow(100, 100, 98),
    });
    const livePlan = computeTradePlan({
      style: 'Scalping',
      anchor: livePrice,
      atrPct: 4,
      capital: 10_000,
      bars: flatWindow(100, 100, 98),
    });
    assert.ok(eodPlan !== null && livePlan !== null);
    // Scalping anchors entry at the price itself, so entry tracks the anchor.
    assert.equal(eodPlan!.entry, 100);
    assert.equal(livePlan!.entry, 110);
    assert.equal(livePlan!.anchor, 110);
    // ATR$ scales with the anchor (4% of 110 vs 4% of 100), so the stop widens.
    assert.ok(livePlan!.stopDistance > eodPlan!.stopDistance);
  });

  it('falls back to the EOD anchor cleanly (same math, no live price)', () => {
    const plan = computeTradePlan({
      style: 'Momentum',
      anchor: 100,
      atrPct: 4,
      capital: 10_000,
      bars: flatWindow(100, 102, 98),
    });
    assert.ok(plan !== null);
    assert.equal(plan!.anchor, 100);
    assert.equal(plan!.entry, 102);
  });
});

describe('computeTradePlan — intraday entry anchoring (the day-trade fix)', () => {
  // The bug: Momentum/Breakout entry was max(10-DAILY-bar high, anchor), i.e. a
  // ~2-week high that sits structurally above the current price (7–15% above in
  // practice). A day-trade entry must sit near the current price — "break of
  // TODAY's high." These assert the entry tracks today's intraday levels when
  // present, falls back (disclosed) when absent, and that stop/target/size still
  // compute correctly off the new entry.

  // The 2-week DailyBar high the OLD logic would have used. Far above the live
  // price to model the real bug (AEO: entry $18.46 vs live $15.99).
  const twoWeekHigh = 18.46;

  it("Momentum: entry = TODAY's high, NOT the multi-day high (entry near live)", () => {
    const live = 15.99;
    const plan = computeTradePlan({
      style: 'Momentum',
      anchor: live,
      atrPct: 4,
      capital: 10_000,
      // bars carry the stale 2-week high; today's high is just above the market.
      bars: flatWindow(15.99, twoWeekHigh, 15.0),
      intraday: { high: 16.2, low: 15.6, open: 15.8 },
    });
    assert.ok(plan !== null);
    assert.equal(plan!.entry, 16.2, "entry = today's high, not the 2-week high");
    assert.match(plan!.entryCondition, /today's high/);
    // Proof it fixed the gap: entry within a few % of live, not 7–15% above.
    const gapPct = ((plan!.entry - live) / live) * 100;
    assert.ok(gapPct < 3, `entry-vs-live gap should be small, got ${gapPct.toFixed(1)}%`);
    // And nowhere near the old broken level.
    assert.ok(plan!.entry < twoWeekHigh - 1, 'entry must be well below the 2-week high');
  });

  it("Momentum: when already at/above today's high, entry ≈ current price (breaking out now)", () => {
    const live = 16.5; // already above today's high of 16.2
    const plan = computeTradePlan({
      style: 'Momentum',
      anchor: live,
      atrPct: 4,
      capital: 10_000,
      bars: flatWindow(16.5, twoWeekHigh, 15.0),
      intraday: { high: 16.2, low: 15.6, open: 15.8 },
    });
    assert.ok(plan !== null);
    assert.equal(plan!.entry, 16.5, 'entry ≈ current price when already breaking out');
    assert.match(plan!.entryCondition, /Breaking out now/);
  });

  it("Breakout: same today's-high anchor as Momentum", () => {
    const plan = computeTradePlan({
      style: 'Breakout',
      anchor: 7.35, // ACDC live
      atrPct: 5,
      capital: 10_000,
      bars: flatWindow(7.35, 8.22, 7.0), // 8.22 = the old broken entry
      intraday: { high: 7.5, low: 7.2, open: 7.3 },
    });
    assert.ok(plan !== null);
    assert.equal(plan!.entry, 7.5);
    assert.match(plan!.entryCondition, /today's high/);
  });

  it("ORB: today's high is the opening-range proxy when present", () => {
    const plan = computeTradePlan({
      style: 'ORB',
      anchor: 25.84, // RGTI live
      atrPct: 6,
      capital: 10_000,
      bars: flatWindow(25.84, 27.79, 25.0), // 27.79 = the old broken entry
      intraday: { high: 26.1, low: 25.5, open: 25.7 },
    });
    assert.ok(plan !== null);
    assert.equal(plan!.entry, 26.1);
    assert.match(plan!.entryCondition, /opening-range proxy/);
  });

  it('ORB: early-session (no intraday high) anchors to current + notes "mark the range live"', () => {
    const plan = computeTradePlan({
      style: 'ORB',
      anchor: 25.84,
      atrPct: 6,
      capital: 10_000,
      bars: flatWindow(25.84, 27.79, 25.0),
      // No intraday levels at all (just before/at the open).
    });
    assert.ok(plan !== null);
    assert.equal(plan!.entry, 25.84, 'anchors to current price, not the 2-week high');
    assert.match(plan!.entryCondition, /mark the range live/);
    assert.match(plan!.entryCondition, /end-of-day anchor/);
  });

  it('Momentum fallback discloses EOD when no intraday data (never silently stale)', () => {
    const plan = computeTradePlan({
      style: 'Momentum',
      anchor: 15.99,
      atrPct: 4,
      capital: 10_000,
      bars: flatWindow(15.99, twoWeekHigh, 15.0),
      // No intraday → fallback to the multi-day high, but it must say so.
    });
    assert.ok(plan !== null);
    assert.equal(plan!.entry, twoWeekHigh, 'fallback still uses the multi-day high');
    assert.match(plan!.entryCondition, /end-of-day level/);
    assert.match(plan!.entryCondition, /market's open/);
  });

  it("stop / target / size compute correctly off the today's-high entry", () => {
    // entry = today's high 16.2; ATR 4% of anchor 16 → ATR$ 0.64; Momentum 1.5×
    // stop = 0.96; stop = 16.2 − 0.96 = 15.24; target = 16.2 + 2×0.96 = 18.12.
    const plan = computeTradePlan({
      style: 'Momentum',
      anchor: 16,
      atrPct: 4,
      capital: 10_000,
      bars: flatWindow(16, 18.46, 15),
      intraday: { high: 16.2, low: 15.6, open: 15.8 },
    });
    assert.ok(plan !== null);
    assert.equal(plan!.entry, 16.2);
    assert.equal(plan!.stopAtrMult, 1.5);
    assert.equal(plan!.stop, 15.24);
    assert.equal(plan!.stopDistance, 0.96);
    assert.equal(plan!.target, 18.12);
    // size: riskPerTrade = 100; shares = floor(100 / 0.96) = 104.
    assert.equal(plan!.riskPerTrade, 100);
    assert.equal(plan!.shares, 104);
    assert.ok(plan!.dollarRisk <= plan!.riskPerTrade);
  });

  it('ignores zero/negative intraday levels (treats them as absent → EOD fallback)', () => {
    const plan = computeTradePlan({
      style: 'Momentum',
      anchor: 15.99,
      atrPct: 4,
      capital: 10_000,
      bars: flatWindow(15.99, twoWeekHigh, 15.0),
      intraday: { high: 0, low: -1, open: 0 }, // garbage → ignored
    });
    assert.ok(plan !== null);
    assert.equal(plan!.entry, twoWeekHigh, 'garbage intraday falls back to EOD');
    assert.match(plan!.entryCondition, /end-of-day level/);
  });
});

describe('selectDisplayPrice — freshest-price-wins, honestly labeled (Fix 2/3)', () => {
  // Timestamps are real UTC instants; selectDisplayPrice classifies the session
  // in America/New_York (ET). Helpers build instants from an explicit UTC clock
  // so the ET session is unambiguous regardless of where the test runs.
  const utc = (iso: string): Date => new Date(iso);

  it('THE ACVA CASE: after-hours print beats the older Monday close', () => {
    // The confirmed bug. LivePrice $6.32 fetched 2026-06-02 20:57 UTC = 16:57 ET
    // (after Tuesday's 16:00 close → after-hours). Latest DailyBar = Monday
    // 2026-06-01 close $6.54 (Tuesday's EOD bar not ingested yet). Evaluated at
    // 2026-06-03 05:27 UTC = 01:27 ET Wednesday (overnight). The scanner MUST
    // show the $6.32 after-hours price, NOT the stale $6.54 Monday close.
    const d = selectDisplayPrice({
      live: { price: 6.32, fetchedAt: utc('2026-06-02T20:57:04Z'), priorClose: 6.54 },
      lastClose: { price: 6.54, date: utc('2026-06-01T00:00:00Z') },
      now: utc('2026-06-03T05:27:00Z'),
    });
    assert.ok(d !== null);
    assert.equal(d!.price, 6.32, 'shows the after-hours $6.32, not the Monday $6.54');
    assert.equal(d!.session, 'afterhours', 'labeled after-hours (16:57 ET)');
    assert.equal(d!.isLive, false, 'an hours-old after-hours print is NOT "live"');
    assert.equal(d!.asOf.toISOString(), '2026-06-02T20:57:04.000Z');
    // Move base is the prior close → (6.32 − 6.54)/6.54 = −3.36%.
    assert.equal(d!.changePct, -3.36);
  });

  it('a fresh regular-hours print is "live"', () => {
    // 2026-06-02 15:04 UTC = 11:04 ET, inside 9:30-16:00, fetched 2 min ago.
    const now = utc('2026-06-02T15:06:00Z');
    const d = selectDisplayPrice({
      live: { price: 6.32, fetchedAt: utc('2026-06-02T15:04:00Z'), priorClose: 6.2 },
      lastClose: { price: 6.2, date: utc('2026-06-01T00:00:00Z') },
      now,
    });
    assert.ok(d !== null);
    assert.equal(d!.session, 'live');
    assert.equal(d!.isLive, true);
    assert.equal(d!.changePct, 1.94); // (6.32-6.2)/6.2
  });

  it('a stale same-session (regular-hours) row reads as "close", not fake-live', () => {
    // Fetched 13:00 ET but evaluated 15:30 ET — inside regular hours but 2.5h
    // old, so it is the last regular print we hold, not "live".
    const d = selectDisplayPrice({
      live: { price: 10, fetchedAt: utc('2026-06-02T17:00:00Z'), priorClose: 10 },
      lastClose: { price: 9.9, date: utc('2026-06-01T00:00:00Z') },
      now: utc('2026-06-02T19:30:00Z'),
    });
    assert.ok(d !== null);
    assert.equal(d!.session, 'close');
    assert.equal(d!.isLive, false);
  });

  it('labels a pre-market print', () => {
    // 2026-06-02 12:30 UTC = 08:30 ET (04:00-09:30 → pre-market).
    const d = selectDisplayPrice({
      live: { price: 50, fetchedAt: utc('2026-06-02T12:30:00Z'), priorClose: 49 },
      lastClose: { price: 49, date: utc('2026-06-01T00:00:00Z') },
      now: utc('2026-06-02T12:32:00Z'),
    });
    assert.ok(d !== null);
    assert.equal(d!.session, 'premarket');
    assert.equal(d!.isLive, false);
  });

  it('boundary: exactly 16:00 ET is after-hours (close is exclusive)', () => {
    // 2026-06-02 20:00 UTC = 16:00 ET sharp.
    const d = selectDisplayPrice({
      live: { price: 50, fetchedAt: utc('2026-06-02T20:00:00Z'), priorClose: 49 },
      lastClose: { price: 49, date: utc('2026-06-01T00:00:00Z') },
      now: utc('2026-06-02T20:01:00Z'),
    });
    assert.equal(d!.session, 'afterhours');
  });

  it('boundary: exactly 09:30 ET is live (open is inclusive)', () => {
    // 2026-06-02 13:30 UTC = 09:30 ET sharp, fetched at the open.
    const d = selectDisplayPrice({
      live: { price: 50, fetchedAt: utc('2026-06-02T13:30:00Z'), priorClose: 49 },
      lastClose: { price: 49, date: utc('2026-06-01T00:00:00Z') },
      now: utc('2026-06-02T13:30:30Z'),
    });
    assert.equal(d!.session, 'live');
    assert.equal(d!.isLive, true);
  });

  it('boundary: 03:59 ET (before pre-market open) is overnight → close', () => {
    // 2026-06-02 07:59 UTC = 03:59 ET — before the 04:00 pre-market open.
    const d = selectDisplayPrice({
      live: { price: 50, fetchedAt: utc('2026-06-02T07:59:00Z'), priorClose: 49 },
      lastClose: { price: 49, date: utc('2026-06-01T00:00:00Z') },
      now: utc('2026-06-02T07:59:30Z'),
    });
    assert.equal(d!.session, 'close');
  });

  it('falls back to the DailyBar (prior-close) only when no LivePrice exists', () => {
    const d = selectDisplayPrice({
      live: null,
      lastClose: { price: 6.54, date: utc('2026-06-01T00:00:00Z') },
      now: utc('2026-06-03T05:27:00Z'),
    });
    assert.ok(d !== null);
    assert.equal(d!.price, 6.54);
    assert.equal(d!.session, 'prior-close');
    assert.equal(d!.isLive, false);
    assert.equal(d!.changePct, null);
  });

  it('falls back to the DailyBar when the LivePrice is genuinely OLDER than it', () => {
    // Live fetched Friday; DailyBar is the following Monday (a newer session) —
    // the daily close is the most recent thing, so it wins.
    const d = selectDisplayPrice({
      live: { price: 100, fetchedAt: utc('2026-05-29T20:00:00Z'), priorClose: 99 },
      lastClose: { price: 102, date: utc('2026-06-01T00:00:00Z') },
      now: utc('2026-06-02T05:00:00Z'),
    });
    assert.ok(d !== null);
    assert.equal(d!.price, 102, 'the newer daily close wins over the older live row');
    assert.equal(d!.session, 'prior-close');
  });

  it('returns null when no usable price exists at all', () => {
    assert.equal(selectDisplayPrice({ live: null, lastClose: null, now: new Date() }), null);
    assert.equal(
      selectDisplayPrice({
        live: { price: 0, fetchedAt: new Date(), priorClose: null },
        lastClose: { price: -1, date: new Date() },
        now: new Date(),
      }),
      null,
    );
  });
});

describe('ATR in dollars (Fix 1)', () => {
  it('atrDollars = atrPct/100 × referencePrice', () => {
    // The displayed-price math the UI renders as "ATR 5.9% (≈$0.39)".
    assert.equal(Math.round((5.9 / 100) * 6.6 * 100) / 100, 0.39);
    // A higher-priced name: ATR 4% of $250 = $10.00.
    assert.equal(Math.round((4 / 100) * 250 * 100) / 100, 10);
  });
});

describe('selectActionableCandidates — 0-share filter + backfill', () => {
  // Minimal candidate factory: only the fields the selector reads (fitScore +
  // the plan's shares/entry + price fallbacks) matter; the rest are filler so it
  // type-checks as a full DayTradeCandidate.
  function candidate(opts: {
    ticker: string;
    fitScore: number;
    shares: number;
    entry?: number;
  }): DayTradeCandidate {
    const entry = opts.entry ?? 100;
    const plan: TradePlan = {
      anchor: entry,
      entryCondition: 'test',
      entry,
      stop: entry - 1,
      stopDistance: 1,
      stopPct: 1,
      stopAtrMult: 1.5,
      target: entry + 2,
      rewardRiskRatio: 2,
      shares: opts.shares,
      positionValue: opts.shares * entry,
      riskPerTrade: 10,
      dollarRisk: opts.shares * 1,
      capital: 1000,
      nativeToCadRate: 1,
    };
    return {
      ticker: opts.ticker,
      name: opts.ticker,
      lastClose: entry,
      currency: 'USD',
      atrPct: 4,
      relativeVolume: 1,
      avgDollarVolume: 50_000_000,
      beta: 1,
      recentCatalyst: null,
      fitScore: opts.fitScore,
      reason: 'test',
      asOf: new Date(),
      livePrice: entry,
      liveChangePct: 0,
      liveAsOf: new Date(),
      displayPrice: entry,
      priceSession: 'live',
      displayAsOf: new Date(),
      displayChangePct: 0,
      atrDollars: 4,
      plan,
    };
  }

  it('drops 0-share names and backfills with the next-ranked sizeable ones', () => {
    // Ranked desc by fit. The two highest-fit names are un-buyable (0 shares);
    // the selector must skip them and still fill the list with sizeable names.
    const ranked = [
      candidate({ ticker: 'AMD', fitScore: 90, shares: 0 }), // pricey → 0 shares
      candidate({ ticker: 'NVDA', fitScore: 85, shares: 0 }), // pricey → 0 shares
      candidate({ ticker: 'F', fitScore: 70, shares: 40 }),
      candidate({ ticker: 'SOFI', fitScore: 60, shares: 80 }),
      candidate({ ticker: 'PLTR', fitScore: 55, shares: 12 }),
    ];
    const out = selectActionableCandidates(ranked, { capital: 1000, limit: 3 });
    assert.equal(out.length, 3, 'list stays full after dropping the 0-share names');
    assert.ok(
      out.every((c) => (c.plan?.shares ?? 0) >= 1),
      'every returned candidate is sizeable (>= 1 share)',
    );
    assert.deepEqual(
      out.map((c) => c.ticker),
      ['F', 'SOFI', 'PLTR'],
      'backfilled from the next-ranked sizeable names, fit order preserved',
    );
  });

  it('keeps the list full when there are enough sizeable names below the dropped ones', () => {
    const ranked = [
      candidate({ ticker: 'A', fitScore: 80, shares: 0 }),
      candidate({ ticker: 'B', fitScore: 70, shares: 10 }),
      candidate({ ticker: 'C', fitScore: 60, shares: 10 }),
      candidate({ ticker: 'D', fitScore: 50, shares: 10 }),
      candidate({ ticker: 'E', fitScore: 40, shares: 10 }),
    ];
    const out = selectActionableCandidates(ranked, { capital: 1000, limit: 4 });
    assert.equal(out.length, 4);
    assert.ok(out.every((c) => (c.plan?.shares ?? 0) >= 1));
    assert.ok(!out.some((c) => c.ticker === 'A'));
  });

  it('falls back to the cheapest-few (not empty) when the WHOLE list is unsizeable', () => {
    // Tiny capital: nothing sizes. Show the least-unaffordable names by entry
    // price rather than an empty table; their per-row 0-share note explains why.
    const ranked = [
      candidate({ ticker: 'EXP', fitScore: 90, shares: 0, entry: 800 }),
      candidate({ ticker: 'MID', fitScore: 80, shares: 0, entry: 300 }),
      candidate({ ticker: 'CHP', fitScore: 70, shares: 0, entry: 40 }),
      candidate({ ticker: 'CHPR', fitScore: 60, shares: 0, entry: 25 }),
    ];
    const out = selectActionableCandidates(ranked, { capital: 50, limit: 8 });
    assert.ok(out.length > 0, 'never returns an empty list at tiny capital');
    assert.equal(out.length, 3, 'shows the cheapest few (capped)');
    assert.deepEqual(
      out.map((c) => c.ticker),
      ['CHPR', 'CHP', 'MID'],
      'cheapest by entry price first',
    );
  });

  it('does NOT filter when capital is 0 (no sizing requested) — returns top by fit', () => {
    // At capital 0 every share count is 0 by construction; filtering would empty
    // the list, so the selector returns the top `limit` as-is.
    const ranked = [
      candidate({ ticker: 'A', fitScore: 80, shares: 0 }),
      candidate({ ticker: 'B', fitScore: 70, shares: 0 }),
      candidate({ ticker: 'C', fitScore: 60, shares: 0 }),
    ];
    const out = selectActionableCandidates(ranked, { capital: 0, limit: 2 });
    assert.equal(out.length, 2);
    assert.deepEqual(
      out.map((c) => c.ticker),
      ['A', 'B'],
    );
  });

  it('respects the limit even when more sizeable names exist', () => {
    const ranked = Array.from({ length: 10 }, (_, i) =>
      candidate({ ticker: `T${i}`, fitScore: 90 - i, shares: 10 }),
    );
    const out = selectActionableCandidates(ranked, { capital: 1000, limit: 8 });
    assert.equal(out.length, 8);
  });
});
