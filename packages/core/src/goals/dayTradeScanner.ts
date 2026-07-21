/**
 * Day-trade candidate scanner — surfaces stocks to WATCH for intraday setups,
 * NOT live execution signals.
 *
 * DATA SHAPE: ATR%, relative volume, and catalysts are computed from end-of-day
 * bars (DailyBar) + TickerMetrics — volatility/liquidity are legitimately daily
 * measures. The PRICE and the trade-plan ENTRY, however, use TODAY's intraday
 * levels when available: pollPrices writes the live price + today's open/high/low
 * (Alpaca snapshot, IEX) to LivePrice for the scanner universe, and the entry
 * anchors to "break of today's high," not a multi-day DailyBar high. When the
 * market's closed (no fresh snapshot) the entry falls back to the daily-bar level
 * and the plan DISCLOSES it. The user still does their own live tape analysis
 * before trading; the UI states this explicitly.
 *
 * Mirrors the DB-querying style of loaders.ts: the engine stays pure, this file
 * does the Prisma work. Scoped to a tractable universe (tickers with BOTH recent
 * DailyBar data AND TickerMetrics — a few hundred at most), never the full ~11k.
 */

import { prisma } from '@vantage/db';
import { isYieldTrap } from './securityPool.js';
import type { TradingStyle } from './engine.js';

/**
 * A rules-based, computed trade plan for one candidate. These are NOT
 * predictions — they're mechanical levels derived from ATR + recent bars + the
 * 1%-risk rule, so the user can act on a concrete plan instead of eyeballing.
 * Entry is a level + condition (not a fake-precise single number); stop is
 * ATR-based; target is a fixed reward:risk multiple of the stop distance; size
 * follows from the goal's capital and the stop distance.
 */
export interface TradePlan {
  /** The price the plan is anchored to — live price when available, else the latest close. */
  anchor: number;
  /** Human-readable entry trigger, e.g. "Break above $16.10 (today's high) on rising volume". */
  entryCondition: string;
  /** The reference entry level the stop/target/size math uses. */
  entry: number;
  /** ATR-based hard stop level. */
  stop: number;
  /** entry − stop, the per-share risk (always > 0). */
  stopDistance: number;
  /** stopDistance as a % of entry. */
  stopPct: number;
  /** Multiple of ATR$ used for the stop (1.0–1.5 by style). */
  stopAtrMult: number;
  /** Profit target = entry + rewardRiskRatio × stopDistance. */
  target: number;
  /** Reward:risk ratio baked into the target (2 = 2:1). */
  rewardRiskRatio: number;
  /** Whole shares: floor(riskPerTrade / stopDistance). 0 when capital can't fund one share at this risk. */
  shares: number;
  /** shares × entry, converted to CAD. */
  positionValue: number;
  /** 1% of CAD trading capital. */
  riskPerTrade: number;
  /** Actual CAD at risk after share rounding (<= riskPerTrade). */
  dollarRisk: number;
  /** CAD trading capital the size was computed from. */
  capital: number;
  /** CAD value of one unit of the listing currency. CAD=1; USD=USD/CAD. */
  nativeToCadRate: number;
}

export interface DayTradeCandidate {
  ticker: string;
  name: string | null;
  lastClose: number | null;
  currency: 'CAD' | 'USD';
  atrPct: number | null; // 14-day ATR as % of price (volatility)
  relativeVolume: number | null; // latest volume / 30d avg volume
  avgDollarVolume: number | null; // liquidity (TickerMetrics.avgDollarVolume30d)
  beta: number | null;
  recentCatalyst: string | null; // most recent MarketEvent kind+date in last 7d
  fitScore: number; // 0..100 suitability for the chosen style
  reason: string;
  // Date of the latest DailyBar the ATR%/RVOL/price were computed from. The UI
  // uses this to disclose data staleness — these are end-of-day readings, not
  // live, and the EOD feed can lag a trading day or more.
  asOf: Date | null;
  // Live price (latest Alpaca trade) when a fresh LivePrice row exists, plus
  // today's % move and the as-of time. When livePrice is set the UI prefers it
  // over lastClose for the displayed price; otherwise it falls back to lastClose
  // (EOD) with the staleness banner. ATR%/RVOL above stay DAILY-derived.
  // NOTE: `livePrice` is set ONLY for a genuinely-live (regular-hours, <10 min)
  // print, for backward compat with the "green dot = live" UI. The freshest
  // real price the scanner DISPLAYS — including pre-market / after-hours / close
  // — is `displayPrice` below; prefer it for what to show.
  livePrice: number | null;
  liveChangePct: number | null; // (live − today's open or prior close) / base × 100
  liveAsOf: Date | null;
  // The freshest real price the scanner holds, with an honest session label +
  // as-of time (Fix 2/3). ALWAYS the most-recent datum among the LivePrice row
  // and the latest DailyBar — never an older daily close when a newer LivePrice
  // exists. `session` tells the UI which session it's from (live / pre-market /
  // after-hours / close / prior-close) so it labels honestly. Null only when no
  // usable price exists at all.
  displayPrice: number | null;
  priceSession: PriceSession | null;
  displayAsOf: Date | null;
  displayChangePct: number | null; // today's move vs the right base (prior close)
  // ATR in DOLLARS at the displayed/current price: atrPct/100 × displayPrice
  // (Fix 1). Lets the UI show "ATR 5.9% (≈$0.39)" without re-deriving the base.
  atrDollars: number | null;
  // Prescriptive, rules-based plan (entry/stop/target/size). Null only when the
  // math can't be formed (e.g. no usable ATR or non-positive anchor).
  plan: TradePlan | null;
}

// LIQUIDITY FLOOR — below $5M average daily dollar-volume you can't reliably get
// in and out without moving the price against yourself.
const MIN_DOLLAR_VOLUME = 5_000_000;
// A day-trade name has to actually move. ATR% under ~2% is too quiet to scalp.
const MIN_ATR_PCT = 2;
// 15 bars → exactly 14 TRs for a 14-period ATR (the first bar only supplies a
// prevClose). slice(-14) on 14 TRs is then the identity — nothing is dropped.
// 15 closes is also exactly what computeRsi needs (period + 1).
const BARS_PER_TICKER = 15;

function currencyOf(currency: string | null | undefined): 'CAD' | 'USD' {
  return currency === 'CAD' ? 'CAD' : 'USD';
}

interface Bar {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * 14-period Average True Range as a percentage of the latest close.
 * TR_t = max(high-low, |high - prevClose|, |low - prevClose|).
 * Bars must be ascending by date. Returns null when fewer than 2 bars or the
 * latest close is non-positive.
 */
export function computeAtrPct(bars: readonly Bar[], period = 14): number | null {
  if (bars.length < 2) return null;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const cur = bars[i]!;
    const prevClose = bars[i - 1]!.close;
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prevClose),
      Math.abs(cur.low - prevClose),
    );
    if (Number.isFinite(tr)) trs.push(tr);
  }
  if (trs.length === 0) return null;
  // Use the trailing `period` TRs (simple mean — Wilder smoothing is overkill
  // for a daily-data watchlist signal). Fewer than `period` → average what we have.
  const recent = trs.slice(-period);
  const atr = recent.reduce((s, v) => s + v, 0) / recent.length;
  const lastClose = bars[bars.length - 1]!.close;
  if (!Number.isFinite(lastClose) || lastClose <= 0) return null;
  return (atr / lastClose) * 100;
}

/**
 * Wilder-style RSI over closes (default 14). Used by the MeanReversion style to
 * find oversold/overbought extremes. Returns null when insufficient data.
 */
export function computeRsi(closes: readonly number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const delta = closes[i]! - closes[i - 1]!;
    if (delta >= 0) gains += delta;
    else losses -= delta;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Trailing return over the last `lookback` bars: (last - first) / first. */
function recentReturn(closes: readonly number[], lookback = 5): number | null {
  if (closes.length < 2) return null;
  const start = closes[Math.max(0, closes.length - 1 - lookback)]!;
  const end = closes[closes.length - 1]!;
  if (!Number.isFinite(start) || start <= 0) return null;
  return end / start - 1;
}

/** Fraction of the trailing-N high the latest close sits at (1.0 = at the high). */
function nearRangeHigh(bars: readonly Bar[], lookback = 14): number | null {
  if (bars.length < 2) return null;
  const window = bars.slice(-lookback);
  const hi = Math.max(...window.map((b) => b.high));
  const last = bars[bars.length - 1]!.close;
  if (!Number.isFinite(hi) || hi <= 0) return null;
  return last / hi;
}

/** Highest high / lowest low over the trailing-N bars. Null when no usable bars. */
function rangeExtremes(bars: readonly Bar[], lookback = 10): { high: number; low: number } | null {
  if (bars.length === 0) return null;
  const window = bars.slice(-lookback);
  const high = Math.max(...window.map((b) => b.high));
  const low = Math.min(...window.map((b) => b.low));
  if (!Number.isFinite(high) || !Number.isFinite(low) || high <= 0) return null;
  return { high, low };
}

// Bars looked back over for the breakout-level / range extremes the entry
// trigger references. 10 trading days is the standard short-term breakout window
// and is comfortably inside the ~15 bars the scanner already holds per ticker.
const PLAN_LOOKBACK = 10;
// Default reward:risk on the target. 2:1 is the textbook day-trade floor — you
// can be right under half the time and still net positive.
const REWARD_RISK_RATIO = 2;

/**
 * Per-style stop width as a multiple of ATR$. Trend styles (Momentum/Breakout/
 * ORB) get a wider 1.5× stop so normal noise doesn't shake them out; reversion
 * and scalps get a tighter 1.0× since they're fading a move / scalping a small
 * range. All within the spec's 1.0–1.5 band.
 */
function stopAtrMultFor(style: TradingStyle): number {
  switch (style) {
    case 'MeanReversion':
    case 'Scalping':
      return 1.0;
    default:
      return 1.5;
  }
}

/**
 * Today's intraday levels (Alpaca snapshot, IEX). `high`/`low`/`open` are the
 * current session's range so far. When present the trade plan anchors entries to
 * TODAY's levels (break of today's high) instead of a multi-day DailyBar high —
 * the difference between an intraday day-trade entry and a swing-breakout level.
 * All optional: any field absent (market closed, no snapshot, or too early for a
 * meaningful range) drops the plan to the disclosed end-of-day fallback.
 */
export interface IntradayLevels {
  high: number | null;
  low: number | null;
  open: number | null;
}

/**
 * Build the rules-based trade plan for one candidate. PURE — all DB/live data is
 * passed in. `anchor` is the price the plan hangs off (live price when fresh,
 * else the latest close). `atrPct` is the 14-day ATR as % of price (daily-
 * derived volatility). `capital` is the goal's trading capital for the 1%-risk
 * size. `bars` supply the recent high/low the EOD-fallback trigger references.
 *
 * `intraday` carries TODAY's high/low/open (Alpaca snapshot). For a DAY trade
 * the entry must sit near where the stock trades NOW, so when today's levels are
 * present the entry anchors to them — "break of today's high," not the 2-week
 * high. Without them (market closed / no snapshot) the entry falls back to the
 * prior daily-bar behavior and the condition DISCLOSES that the levels are
 * end-of-day, so a stale multi-day level is never shown as if it were live.
 *
 * Honest framing: every level here is computed, not forecast. Entry is stated as
 * a level + condition; the stop is non-negotiable; size caps the loss at ~1% of
 * capital if the stop is hit.
 *
 * Price levels are in the listing currency. Position value and risk totals are
 * converted to CAD through `nativeToCadRate`, so a US trade cannot exceed the
 * goal's 1% CAD risk budget merely because its stop is denominated in USD.
 */
export function computeTradePlan(opts: {
  style: TradingStyle;
  anchor: number;
  atrPct: number;
  capital: number;
  currency?: 'CAD' | 'USD';
  nativeToCadRate?: number;
  bars: readonly Bar[];
  intraday?: IntradayLevels;
  rewardRiskRatio?: number;
}): TradePlan | null {
  const { style, anchor, atrPct, capital, bars } = opts;
  const rewardRiskRatio = opts.rewardRiskRatio ?? REWARD_RISK_RATIO;
  const nativeToCadRate = opts.nativeToCadRate ?? 1;
  if (!Number.isFinite(anchor) || anchor <= 0) return null;
  if (!Number.isFinite(atrPct) || atrPct <= 0) return null;
  if (!Number.isFinite(nativeToCadRate) || nativeToCadRate <= 0) return null;

  const atrDollars = (atrPct / 100) * anchor;
  if (!Number.isFinite(atrDollars) || atrDollars <= 0) return null;

  const extremes = rangeExtremes(bars, PLAN_LOOKBACK);
  const round = (v: number): number => Math.round(v * 100) / 100;
  const pricePrefix = opts.currency === 'CAD' ? 'C$' : '$';

  // Today's intraday levels, validated. A level is usable only when finite and
  // positive; anything else is treated as absent (→ EOD fallback for that style).
  const pos = (v: number | null | undefined): number | null =>
    v != null && Number.isFinite(v) && v > 0 ? v : null;
  const todayHigh = pos(opts.intraday?.high);
  const todayLow = pos(opts.intraday?.low);
  // Any intraday level present means the market data is live for today — drives
  // the EOD-disclosure suffix on the fallback styles (ORB).
  const hasIntraday = todayHigh !== null || todayLow !== null;

  // Entry trigger varies by style. The level is what the stop/target/size math
  // uses; the condition is the human-readable trigger. For a DAY trade the level
  // anchors to TODAY's intraday range when we have it; the prior multi-day high
  // is only an explicitly-disclosed end-of-day fallback.
  let entry: number;
  let entryCondition: string;
  switch (style) {
    case 'Momentum':
    case 'Breakout': {
      if (todayHigh !== null) {
        // Break of TODAY's high — an intraday day-trade entry that sits right at
        // the current price. If we're already at/above today's high we're
        // breaking out now, so enter at the current price rather than chase.
        if (anchor >= todayHigh) {
          entry = round(anchor);
          entryCondition = `Breaking out now — entry ≈ ${pricePrefix}${entry.toFixed(2)} (at/above today's high ${pricePrefix}${todayHigh.toFixed(2)}); confirm on rising volume`;
        } else {
          entry = round(todayHigh);
          entryCondition = `Break above ${pricePrefix}${entry.toFixed(2)} (today's high) on rising volume`;
        }
      } else {
        // No intraday data — fall back to the multi-day high and DISCLOSE it.
        const level = extremes ? Math.max(extremes.high, anchor) : anchor;
        entry = round(level);
        entryCondition = `Break above ${pricePrefix}${entry.toFixed(2)} (${PLAN_LOOKBACK}-day high) — end-of-day level; today's intraday high loads when the market's open`;
      }
      break;
    }
    case 'ORB': {
      // Opening-range breakout: today's high is the opening-range-high proxy once
      // a session is underway. Early in the session (no intraday high yet) it
      // isn't meaningful — say to mark the first 5–15 min range live.
      if (todayHigh !== null) {
        entry = round(Math.max(todayHigh, anchor));
        entryCondition = `Break of today's high ${pricePrefix}${entry.toFixed(2)} (opening-range proxy); refine with the first 5–15 min range live`;
      } else {
        entry = round(anchor);
        entryCondition = `Break of the first 5–15 min opening range (anchor ${pricePrefix}${entry.toFixed(2)}); mark the range live${hasIntraday ? '' : ' — end-of-day anchor until the market opens'}`;
      }
      break;
    }
    case 'MeanReversion': {
      // Fade the extreme: buy a bounce near today's low / current price, not a
      // multi-day level. Entry sits a touch above today's low when we have it,
      // capped at the current price so we never post an entry above the market.
      if (todayLow !== null) {
        const level = Math.min(anchor, todayLow + atrDollars * 0.5);
        entry = round(level);
        entryCondition = `Bounce entry near ${pricePrefix}${entry.toFixed(2)} (toward today's low ${pricePrefix}${todayLow.toFixed(2)} / oversold reclaim)`;
      } else {
        // No intraday low — anchor at the current price (a near-the-market
        // reversion entry) and disclose the missing intraday range.
        entry = round(anchor);
        entryCondition = `Bounce entry near ${pricePrefix}${entry.toFixed(2)} (oversold reclaim) — intraday low loads when the market's open`;
      }
      break;
    }
    case 'Scalping': {
      // Scalps work the current price with a tight stop. Keep the honest caveat.
      entry = round(anchor);
      entryCondition = `Scalp near ${pricePrefix}${entry.toFixed(2)} with a tight stop — note: most scalpers lose long-term`;
      break;
    }
  }

  const stopAtrMult = stopAtrMultFor(style);
  const rawStopDistance = stopAtrMult * atrDollars;
  // Stop must sit below entry by a positive distance. Guard the degenerate case.
  const stop = round(Math.max(0, entry - rawStopDistance));
  const stopDistance = round(entry - stop);
  if (stopDistance <= 0) return null;
  const stopPct = round((stopDistance / entry) * 100);
  const target = round(entry + rewardRiskRatio * stopDistance);

  const riskPerTrade = round(Math.max(0, capital) * 0.01);
  const stopRiskCad = stopDistance * nativeToCadRate;
  const shares = stopRiskCad > 0 ? Math.floor(riskPerTrade / stopRiskCad) : 0;
  const positionValue = round(shares * entry * nativeToCadRate);
  const dollarRisk = round(shares * stopDistance * nativeToCadRate);

  return {
    anchor: round(anchor),
    entryCondition,
    entry,
    stop,
    stopDistance,
    stopPct,
    stopAtrMult,
    target,
    rewardRiskRatio,
    shares,
    positionValue,
    riskPerTrade,
    dollarRisk,
    capital: round(Math.max(0, capital)),
    nativeToCadRate,
  };
}

interface Signals {
  atrPct: number | null;
  relativeVolume: number | null;
  avgDollarVolume: number | null;
  rsi: number | null;
  recentRet: number | null; // 5-day
  rangeHighFrac: number | null; // close / 14d high
  hasCatalyst: boolean;
}

/**
 * Style-specific fitScore (0..100) plus a 1-line reason. Each style weights the
 * signals differently per the research design. Scalping is honestly flagged.
 */
export function scoreCandidate(
  style: TradingStyle,
  s: Signals,
  catalystLabel: string | null,
): { fit: number; reason: string } {
  const rvol = s.relativeVolume ?? 1;
  const atr = s.atrPct ?? 0;
  const advolM = (s.avgDollarVolume ?? 0) / 1_000_000;
  const parts: string[] = [];
  if (s.relativeVolume != null) parts.push(`RVOL ${rvol.toFixed(1)}x`);
  if (s.atrPct != null) parts.push(`ATR ${atr.toFixed(1)}%`);
  if (catalystLabel) parts.push(catalystLabel);

  let fit = 0;
  let tag = '';

  // Liquidity, log-scaled across the realistic range so it actually varies
  // instead of saturating at the floor. Every surviving name clears $5M/day and
  // the leaders run to ~$22B/day, so a linear clamp at $15M painted ~all of them
  // identical. log10($M): $5M->0.7, $100M->2, $1B->3, $22B->4.35; map [0.7,4]->[0,1].
  const liqScore = Math.max(0, Math.min(1, (Math.log10(Math.max(advolM, 1)) - 0.7) / (4 - 0.7)));

  switch (style) {
    case 'Momentum': {
      // Heavy on relative volume + catalyst + positive recent return.
      fit += Math.min(rvol, 5) * 12; // up to 60
      if (s.hasCatalyst) fit += 18;
      if ((s.recentRet ?? 0) > 0) fit += Math.min((s.recentRet ?? 0) * 100, 15);
      fit += Math.min(atr, 8) * 1.5; // a little volatility weight
      tag = 'momentum setup';
      break;
    }
    case 'Breakout': {
      // Near the 14d high + range/volume expansion.
      const proximity = s.rangeHighFrac ?? 0; // ~1.0 = at the high
      fit += Math.max(0, (proximity - 0.9) * 400); // 0.95→20, 1.0→40
      fit += Math.min(rvol, 5) * 8; // up to 40
      fit += Math.min(atr, 8) * 2; // range expansion proxy
      if (s.hasCatalyst) fit += 8;
      tag = 'breakout watch';
      break;
    }
    case 'ORB': {
      // Opening-range breakout needs intraday range to work with → high ATR%
      // and deep liquidity. ATR-led, but liquidity must actually vary (was a
      // constant 25 for the whole surviving universe).
      fit += Math.min(atr, 8) * 7; // up to 56
      fit += liqScore * 25; // liquidity, up to 25 — log-scaled
      fit += Math.min(rvol, 4) * 4;
      tag = 'opening-range candidate';
      break;
    }
    case 'MeanReversion': {
      // RSI extreme (oversold/overbought) + enough volatility to snap back.
      const rsi = s.rsi ?? 50;
      const extreme = Math.max(0, Math.abs(rsi - 50) - 15); // >65 or <35 starts scoring
      fit += Math.min(extreme, 35) * 1.6; // up to 56
      fit += Math.min(atr, 8) * 3; // needs to move to revert
      if (rsi <= 30) parts.push(`RSI ${rsi.toFixed(0)} oversold`);
      else if (rsi >= 70) parts.push(`RSI ${rsi.toFixed(0)} overbought`);
      tag = 'mean-reversion setup';
      break;
    }
    case 'Scalping': {
      // Liquidity is the point — scale it across the real range so the deepest
      // books (TSLA-class) rank up instead of tying a $113M mid-cap. Tight ranges
      // + volume matter for fills; 9% ATR is a negative for a scalp, so ATR gets
      // only a small band. Honest warning: most scalpers lose money long-term.
      fit += liqScore * 60; // up to 60 — log-scaled liquidity is everything
      fit += Math.min(rvol, 4) * 8; // volume matters for fills
      fit += Math.min(Math.max(atr - 2, 0), 4) * 2; // a little range; tighter is fine
      tag = 'liquid scalp candidate — note: most scalpers lose long-term';
      break;
    }
  }

  fit = Math.max(0, Math.min(100, Math.round(fit)));
  const reason = parts.length > 0 ? `${parts.join(', ')} — ${tag}` : tag;
  return { fit, reason };
}

const EVENT_LABEL: Record<string, string> = {
  Earnings: 'earnings',
  EarningsBeat: 'earnings beat',
  Filing8K: '8-K filing',
  Material8K: 'material 8-K',
  BreakingNews: 'breaking news',
  IntradayMove: 'intraday move',
  SectorNews: 'sector news',
  Macro: 'macro event',
  SentimentSpike: 'sentiment spike',
  InsiderCluster: 'insider cluster',
  AnalystUpgrade: 'analyst upgrade',
};

function daysAgoLabel(when: Date, now: Date): string {
  const d = Math.max(0, Math.round((now.getTime() - when.getTime()) / (24 * 3600 * 1000)));
  if (d === 0) return 'today';
  if (d === 1) return '1d ago';
  return `${d}d ago`;
}

// A LivePrice fetched within this window DURING regular hours counts as "live"
// (the price is moving in real time). Outside that window — or outside regular
// hours — the row is no longer "live", but it's still the most-recent real
// price we hold; the session label (Pre-market / After-hours / Close) then
// states WHEN it's from rather than pretending it's live. Mirrors the web
// portfolio/compare loaders' 10-min window so "live" means the same everywhere.
const LIVE_PRICE_MAX_AGE_MS = 10 * 60_000;

/**
 * Which trading session a price print belongs to. Drives the honest label the
 * scanner shows so a price is NEVER implied to be "live" when it's an hours-old
 * after-hours print, and an older daily close is only shown when nothing newer
 * exists.
 *   live        — fetched < ~10 min ago during 9:30-16:00 ET (real-time-ish)
 *   premarket   — fetched 04:00-09:30 ET
 *   afterhours  — fetched 16:00-20:00 ET
 *   close       — fetched after today's regular close but it IS today's close
 *                 (e.g. a snapshot taken at 16:05 that carries the closing bar)
 *   prior-close — an older DailyBar close, shown only when no fresher LivePrice
 */
export type PriceSession = 'live' | 'premarket' | 'afterhours' | 'close' | 'prior-close';

export interface DisplayPrice {
  /** The price to show — always the most-recent real datum we hold. */
  price: number;
  /** Which session the price is from (drives the label + the "is it live" dot). */
  session: PriceSession;
  /** The as-of instant for the price (LivePrice.fetchedAt, or the DailyBar date). */
  asOf: Date;
  /** Prior session's close — the base for "today's move %". Null when unknown. */
  priorClose: number | null;
  /** Today's % move vs priorClose, when both are known. */
  changePct: number | null;
  /** True only for `session === 'live'` (drives the green "live" dot in the UI). */
  isLive: boolean;
}

/** Minutes-of-day (ET) + weekday for an instant, in America/New_York. */
function etClock(when: Date): { minutesOfDay: number; weekday: string; ymd: string } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(when);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  let hour = Number(get('hour'));
  // Intl can emit hour "24" at midnight under hour12:false; normalise to 0.
  if (hour === 24) hour = 0;
  const minute = Number(get('minute'));
  return {
    minutesOfDay: hour * 60 + minute,
    weekday: get('weekday'),
    ymd: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

const MKT_OPEN_MIN = 9 * 60 + 30; // 09:30 ET
const MKT_CLOSE_MIN = 16 * 60; // 16:00 ET
const PREMARKET_OPEN_MIN = 4 * 60; // 04:00 ET
const AFTERHOURS_CLOSE_MIN = 20 * 60; // 20:00 ET

/**
 * Classify a LivePrice fetch instant into its trading session (America/New_York).
 * `ageMs` is now − fetchedAt; a fetch inside regular hours is only "live" when
 * it's also fresh (< LIVE_PRICE_MAX_AGE_MS) — a stale same-session row reads as
 * "close" (the last regular print we hold) rather than a fake "live".
 */
function classifyFetchSession(fetchedAt: Date, ageMs: number): PriceSession {
  const { minutesOfDay, weekday } = etClock(fetchedAt);
  const isWeekend = weekday === 'Sat' || weekday === 'Sun';
  if (!isWeekend && minutesOfDay >= MKT_OPEN_MIN && minutesOfDay < MKT_CLOSE_MIN) {
    return ageMs < LIVE_PRICE_MAX_AGE_MS ? 'live' : 'close';
  }
  if (!isWeekend && minutesOfDay >= PREMARKET_OPEN_MIN && minutesOfDay < MKT_OPEN_MIN) {
    return 'premarket';
  }
  if (!isWeekend && minutesOfDay >= MKT_CLOSE_MIN && minutesOfDay < AFTERHOURS_CLOSE_MIN) {
    return 'afterhours';
  }
  // Overnight (20:00-04:00) or weekend: it's the most recent print we hold but
  // belongs to no active session — treat as the last regular close.
  return 'close';
}

/**
 * Pick the price the scanner DISPLAYS: always the freshest real datum we hold,
 * with an accurate session label + as-of time. PURE.
 *
 * Inputs:
 *   live      — the LivePrice row (price + fetchedAt + prior close), or null.
 *   lastClose — the latest DailyBar close + its session date.
 *   now       — evaluation time.
 *
 * Rule ("freshest wins, honestly labeled"):
 *   - Prefer the LivePrice whenever its fetchedAt is at or after the latest
 *     DailyBar's session date (the common case — the live feed leads the EOD
 *     feed, which can lag a trading day). Label by the fetch's ET session.
 *   - Only fall back to the DailyBar close when there's no LivePrice, or the
 *     LivePrice is genuinely OLDER than the latest daily bar's session — then
 *     it's labeled "prior-close" (an older daily close).
 *   - "Today's move %" computes against the right base: the live row's own
 *     prior close when present, else the daily close (which IS the prior close
 *     when the live row is intraday).
 */
export function selectDisplayPrice(opts: {
  live: { price: number; fetchedAt: Date; priorClose: number | null } | null;
  lastClose: { price: number; date: Date } | null;
  now: Date;
}): DisplayPrice | null {
  const { live, lastClose, now } = opts;
  const liveOk = live != null && Number.isFinite(live.price) && live.price > 0;
  const barOk = lastClose != null && Number.isFinite(lastClose.price) && lastClose.price > 0;

  // Prefer the live row unless the daily bar's session is strictly newer than
  // the live fetch. Compare on the ET calendar day so a same-day after-hours
  // print (later clock time, same date) always beats that day's close, and a
  // genuinely newer daily bar (next session) wins only when it really is newer.
  const preferLive =
    liveOk && (!barOk || etClock(live!.fetchedAt).ymd >= etClock(lastClose!.date).ymd);

  if (preferLive) {
    const ageMs = now.getTime() - live!.fetchedAt.getTime();
    const session = classifyFetchSession(live!.fetchedAt, ageMs);
    // Base for today's move: the live row's prior close, else the daily close
    // (which is the prior session's close when the live print is intraday).
    const priorClose = live!.priorClose ?? (barOk ? lastClose!.price : null);
    const changePct =
      priorClose != null && priorClose > 0
        ? Math.round(((live!.price - priorClose) / priorClose) * 100 * 100) / 100
        : null;
    return {
      price: live!.price,
      session,
      asOf: live!.fetchedAt,
      priorClose,
      changePct,
      isLive: session === 'live',
    };
  }

  if (barOk) {
    return {
      price: lastClose!.price,
      session: 'prior-close',
      asOf: lastClose!.date,
      priorClose: null,
      changePct: null,
      isLive: false,
    };
  }
  return null;
}

/**
 * Scan the live universe for day-trade candidates suited to `style`.
 *
 * Universe scoping: tickers that have BOTH recent DailyBar data AND a
 * TickerMetrics row clearing the liquidity floor. Lottery / high-volatility
 * names are NOT excluded here (unlike the buy-and-hold discovery scan — for
 * day-trading, volatility is the point). The YieldMax blocklist + missing-price
 * tickers are still dropped.
 *
 * `capital` (the goal's trading capital, CAD) drives the per-candidate 1%-risk
 * position size. When omitted, the plan's share/position fields come back 0 but
 * the entry/stop/target levels are still computed.
 *
 * 0-share filter: when `capital` is set, names whose 1%-risk size rounds to 0
 * shares (un-buyable — one share's stop risk exceeds 1% of capital) are dropped
 * and BACKFILLED from the next-ranked candidates, so the caller gets up to
 * `limit` ACTIONABLE names. The whole surviving universe is scored before this
 * cut, so the backfill never starves the list. Only if NOTHING sizes at a tiny
 * capital do we fall back to the cheapest-few (with their per-row 0-share note)
 * instead of returning nothing.
 *
 * Live price: when a fresh LivePrice row exists (Alpaca snapshot, < 10 min old)
 * it becomes the plan anchor + displayed price and yields today's % move, and its
 * today's-high/low anchor the trade-plan entry (break of today's high). Otherwise
 * the latest EOD close is the anchor, the entry falls back to the daily-bar level
 * (disclosed in the entry condition), and the UI shows the staleness banner.
 * ATR%/RVOL stay DAILY-derived either way (volatility is legitimately a daily
 * measure — see the UI note).
 */
export async function scanDayTradeCandidates(opts: {
  style?: TradingStyle;
  limit?: number;
  currency?: 'CAD' | 'USD' | 'both';
  now?: Date;
  capital?: number;
  usdToCad: number;
}): Promise<DayTradeCandidate[]> {
  const style = opts.style ?? 'Momentum';
  const limit = opts.limit ?? 15;
  const currencyFilter = opts.currency ?? 'both';
  const now = opts.now ?? new Date();
  const capital = opts.capital ?? 0;
  if (!Number.isFinite(opts.usdToCad) || opts.usdToCad <= 0) {
    throw new Error('usdToCad must be a positive finite rate');
  }

  // Step 1 — candidate universe: TickerMetrics rows that clear the liquidity
  // floor. avgDollarVolume30d is the gate; without it we can't trust fills.
  const metricsRows = await prisma.tickerMetrics.findMany({
    where: { avgDollarVolume30d: { gte: MIN_DOLLAR_VOLUME } },
    select: {
      ticker: true,
      avgDollarVolume30d: true,
      avgVolume30d: true,
      beta: true,
    },
    orderBy: { avgDollarVolume30d: 'desc' },
    // Cap the scan so it stays tractable even if the universe grows. The
    // liquidity floor already trims most of the ~11k symbols (today only ~40
    // clear it, so the cap is inert). TRUNCATION RISK: once more than 400 names
    // clear the floor, candidates beyond rank 400 by dollar-volume are silently
    // dropped. They're the LOWER-liquidity tail (sort is desc), so it's an
    // acceptable trim for a liquidity-gated scan — but if this fires routinely,
    // surface a "scanned the 400 most-liquid names" note in the UI rather than
    // dropping silently.
    take: 400,
  });
  if (metricsRows.length === 0) return [];

  const tickers = metricsRows.map((m) => m.ticker.toUpperCase());
  const metricsByTicker = new Map(metricsRows.map((m) => [m.ticker.toUpperCase(), m]));

  // Step 2 — pull recent bars (last ~16 per ticker), universe rows (name +
  // exchange/currency), and recent catalysts in parallel.
  const barCutoff = new Date(now.getTime() - 45 * 24 * 3600 * 1000); // ~45 calendar days ≈ 16+ trading bars
  const catalystCutoff = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  const [barRows, universeRows, eventRows, livePriceRows] = await Promise.all([
    prisma.dailyBar.findMany({
      where: { ticker: { in: tickers }, date: { gte: barCutoff } },
      select: {
        ticker: true,
        date: true,
        open: true,
        high: true,
        low: true,
        close: true,
        volume: true,
      },
      orderBy: [{ ticker: 'asc' }, { date: 'asc' }],
    }),
    prisma.tickerUniverse.findMany({
      where: { symbol: { in: tickers } },
      select: { symbol: true, name: true, exchange: true, currency: true },
    }),
    prisma.marketEvent.findMany({
      where: { ticker: { in: tickers }, occurredAt: { gte: catalystCutoff } },
      select: { ticker: true, kind: true, occurredAt: true },
      orderBy: { occurredAt: 'desc' },
    }),
    // Live prices for the whole universe (populated by pollPrices during/near
    // market hours). One row per ticker; freshness is checked per-candidate.
    // dayOpen/dayHigh/dayLow are TODAY's intraday levels (Alpaca snapshot) used
    // to anchor the trade-plan entry to today's range; null on held-only rows
    // or before the market opens (→ disclosed EOD fallback in the plan).
    prisma.livePrice.findMany({
      where: { ticker: { in: tickers } },
      select: {
        ticker: true,
        price: true,
        fetchedAt: true,
        dayOpen: true,
        dayHigh: true,
        dayLow: true,
      },
    }),
  ]);

  // Group bars by ticker (already ordered ticker asc, date asc).
  const barsByTicker = new Map<string, Bar[]>();
  for (const r of barRows) {
    const t = r.ticker.toUpperCase();
    let arr = barsByTicker.get(t);
    if (!arr) {
      arr = [];
      barsByTicker.set(t, arr);
    }
    arr.push({
      date: r.date,
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume),
    });
  }

  const universeBySymbol = new Map(universeRows.map((u) => [u.symbol.toUpperCase(), u]));

  // Live price per ticker, keyed UPPER. Only rows fresher than the staleness
  // window count as live; older rows are ignored and the candidate falls back to
  // its EOD close. dayHigh/dayLow/dayOpen are today's intraday levels (may be
  // null even on a fresh row — e.g. a held-only row, which carries no OHLC).
  const toNum = (v: unknown): number | null => {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const liveByTicker = new Map<
    string,
    {
      price: number;
      fetchedAt: Date;
      dayHigh: number | null;
      dayLow: number | null;
      dayOpen: number | null;
    }
  >();
  for (const r of livePriceRows) {
    const price = Number(r.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    liveByTicker.set(r.ticker.toUpperCase(), {
      price,
      fetchedAt: r.fetchedAt,
      dayHigh: toNum(r.dayHigh),
      dayLow: toNum(r.dayLow),
      dayOpen: toNum(r.dayOpen),
    });
  }

  // Most-recent catalyst per ticker (eventRows already desc by occurredAt).
  const catalystByTicker = new Map<string, { kind: string; occurredAt: Date }>();
  for (const e of eventRows) {
    if (!e.ticker) continue;
    const t = e.ticker.toUpperCase();
    if (!catalystByTicker.has(t))
      catalystByTicker.set(t, { kind: e.kind, occurredAt: e.occurredAt });
  }

  // Step 3 — build + score candidates.
  const candidates: DayTradeCandidate[] = [];
  for (const ticker of tickers) {
    // YieldMax-style synthetic covered-call ETFs are NAV-erosion traps — never
    // surface them anywhere, day-trading included.
    if (isYieldTrap(ticker)) continue;

    const bars = barsByTicker.get(ticker);
    if (!bars || bars.length < 2) continue; // no usable price data
    const trimmed = bars.slice(-BARS_PER_TICKER);
    const closes = trimmed.map((b) => b.close);
    const lastClose = closes[closes.length - 1]!;
    if (!Number.isFinite(lastClose) || lastClose <= 0) continue;

    const atrPct = computeAtrPct(trimmed);
    // Must actually move to be day-trade-able.
    if (atrPct === null || atrPct < MIN_ATR_PCT) continue;

    const m = metricsByTicker.get(ticker)!;
    const avgDollarVolume = m.avgDollarVolume30d ?? null;
    if (avgDollarVolume === null || avgDollarVolume < MIN_DOLLAR_VOLUME) continue;

    const u = universeBySymbol.get(ticker);
    const currency = currencyOf(u?.currency);
    if (currencyFilter !== 'both' && currency !== currencyFilter) continue;

    // relativeVolume = the latest bar's volume vs a trailing average. NOTE:
    // "latest bar" is the most recent DailyBar, which may be a trading day or
    // more old (see asOf / the staleness banner) — this is NOT "today's volume."
    // Primary baseline is TickerMetrics.avgVolume30d (a stable 30d average); the
    // fallback excludes the latest bar so it can't bias the ratio toward 1.0.
    const latestVolume = trimmed[trimmed.length - 1]!.volume;
    let avgVol = m.avgVolume30d ?? null;
    if (avgVol === null || avgVol <= 0) {
      const priorVols = trimmed
        .slice(0, -1)
        .map((b) => b.volume)
        .filter((v) => v > 0);
      avgVol =
        priorVols.length > 0 ? priorVols.reduce((s, v) => s + v, 0) / priorVols.length : null;
    }
    const relativeVolume = avgVol && avgVol > 0 ? latestVolume / avgVol : null;

    const cat = catalystByTicker.get(ticker) ?? null;
    const catalystLabel = cat
      ? `${EVENT_LABEL[cat.kind] ?? cat.kind} ${daysAgoLabel(cat.occurredAt, now)}`
      : null;

    const signals: Signals = {
      atrPct,
      relativeVolume,
      avgDollarVolume,
      rsi: computeRsi(closes),
      recentRet: recentReturn(closes, 5),
      rangeHighFrac: nearRangeHigh(trimmed, 14),
      hasCatalyst: cat !== null,
    };

    const { fit, reason } = scoreCandidate(style, signals, catalystLabel);

    const latestBarDate = trimmed[trimmed.length - 1]!.date;
    const live = liveByTicker.get(ticker);

    // Freshest-price-wins selection (Fix 2/3): pick the most-recent real datum
    // among the LivePrice row and the latest DailyBar, with an honest session
    // label + as-of. Never an older daily close when a newer LivePrice exists.
    const display = selectDisplayPrice({
      live: live ? { price: live.price, fetchedAt: live.fetchedAt, priorClose: lastClose } : null,
      lastClose: { price: lastClose, date: latestBarDate },
      now,
    });
    const displayPrice = display?.price ?? null;
    const priceSession = display?.session ?? null;
    const displayAsOf = display?.asOf ?? null;
    const displayChangePct = display?.changePct ?? null;

    // Strict "live" (regular-hours, <10 min) values, kept for the green-dot UI
    // and backward compat. A pre/after-hours print is NOT "live" here even though
    // it's the freshest price — that distinction is what makes the label honest.
    const isLive = display?.isLive ?? false;
    const livePrice = isLive ? display!.price : null;
    const liveAsOf = isLive ? display!.asOf : null;
    const liveChangePct = isLive ? displayChangePct : null;

    // ATR$ at the displayed/current price (Fix 1). Falls back to lastClose so a
    // value still renders when only the EOD bar exists.
    const atrBase = displayPrice ?? lastClose;
    const atrDollars =
      atrPct != null && atrBase > 0 ? Math.round((atrPct / 100) * atrBase * 100) / 100 : null;

    // Anchor the plan to the freshest displayed price (live / pre / after-hours
    // print when present, else the EOD close) — a day-trade plan must sit near
    // where the stock trades NOW, including the last after-hours print overnight.
    const anchor = displayPrice ?? lastClose;
    // Thread TODAY's intraday levels whenever the chosen datum is the live row's
    // own session (not an older daily-bar fallback) — they belong to that same
    // snapshot. For an after-hours/overnight print today's high/low still frame
    // "break of today's high." A prior-close fallback drops to the disclosed EOD
    // levels instead (stale OHLC would be the wrong session).
    const useIntraday = live != null && priceSession !== null && priceSession !== 'prior-close';
    const intraday: IntradayLevels | undefined = useIntraday
      ? { high: live!.dayHigh, low: live!.dayLow, open: live!.dayOpen }
      : undefined;
    const plan = computeTradePlan({
      style,
      anchor,
      atrPct,
      capital,
      currency,
      nativeToCadRate: currency === 'USD' ? opts.usdToCad : 1,
      bars: trimmed,
      ...(intraday ? { intraday } : {}),
    });

    candidates.push({
      ticker,
      name: u?.name ?? null,
      lastClose,
      currency,
      atrPct,
      relativeVolume,
      avgDollarVolume,
      beta: m.beta ?? null,
      recentCatalyst: catalystLabel,
      fitScore: fit,
      reason,
      asOf: latestBarDate,
      livePrice,
      liveChangePct,
      liveAsOf,
      displayPrice,
      priceSession,
      displayAsOf,
      displayChangePct,
      atrDollars,
      plan,
    });
  }

  candidates.sort((a, b) => b.fitScore - a.fitScore);
  return selectActionableCandidates(candidates, { capital, limit });
}

// When the whole list is unsizeable at a tiny capital we still surface a few of
// the least-unaffordable names (with their per-row 0-share note) rather than an
// empty list.
const FALLBACK_WHEN_NONE_SIZEABLE = 3;

/**
 * Final list selection with the 0-share filter + backfill. PURE — takes the
 * fully-scored candidates (assumed already fitScore-desc) and returns up to
 * `limit` ACTIONABLE ones.
 *
 * A candidate whose 1%-risk size rounds to 0 shares (one share's stop-distance
 * risk exceeds 1% of trading capital — e.g. a $510 stock with a $42 stop on $1k)
 * is un-buyable, so it's dropped and BACKFILLED from the next-ranked names.
 * Because the caller scores the WHOLE surviving universe before this cut, the
 * input is far larger than `limit`, so taking the top `limit` SIZEABLE names is
 * an automatic fitScore-ordered backfill — never a starved list.
 *
 * The filter only applies when sizing was actually requested (`capital > 0`): at
 * capital 0 the share count is 0 for everything by construction (no budget), so
 * filtering on it would empty the list — there the levels still stand and we
 * return the top `limit` as-is. And if NOTHING sizes at a tiny capital, we fall
 * back to the cheapest-few by entry price (the least-unaffordable names) so the
 * user still sees concrete plans instead of an empty table.
 */
export function selectActionableCandidates(
  candidates: readonly DayTradeCandidate[],
  opts: { capital: number; limit: number },
): DayTradeCandidate[] {
  const { capital, limit } = opts;
  if (capital <= 0) return candidates.slice(0, limit);

  const sizeable = candidates.filter((c) => c.plan != null && c.plan.shares >= 1);
  if (sizeable.length > 0) return sizeable.slice(0, limit);

  // Whole list is unsizeable — cheapest-few by entry (closest to fitting 1%).
  const cheapest = [...candidates].sort((a, b) => {
    const ap = a.plan?.entry ?? a.displayPrice ?? a.lastClose ?? Infinity;
    const bp = b.plan?.entry ?? b.displayPrice ?? b.lastClose ?? Infinity;
    return ap - bp;
  });
  return cheapest.slice(0, Math.min(FALLBACK_WHEN_NONE_SIZEABLE, limit));
}
