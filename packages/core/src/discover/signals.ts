/**
 * Discovery signal primitives.
 *
 * Pure functions: they accept pre-fetched DB snapshots and return numbers.
 * No DB access, no side effects. Composition lives in the nightly
 * computeDiscovery job which pulls the relevant windows per-ticker and
 * hands them here.
 *
 * Numeric conventions:
 *   - Fundamental/quality signals and news volume use [0, 10]. Directional
 *     event/momentum signals use smaller signed ranges documented per signal.
 *   - `computeDiscoveryScore` is their weighted composite, roughly [0, 10]
 *     for healthy tickers and slightly below zero under negative catalysts.
 *
 * We keep the API minimal and explicit: callers build the windows they need
 * (e.g. "last 30d earnings events") and pass them in. This keeps the scorer
 * testable with fixtures and avoids coupling the discovery math to the
 * ingestion shape.
 */

import type { Article, MarketEvent } from '@vantage/db';

export type InsiderTxn = {
  /** Net USD value of the transaction. Positive for buys, negative for sells. */
  valueUsd: number;
  /** ISO date or Date of the filing. Transactions older than 90d are ignored. */
  transactionDate: Date;
};

export type Bar = {
  date: Date;
  close: number;
};

export interface TickerMetricsLike {
  // valuation
  peTtm?: number | null;
  pegTtm?: number | null;
  psTtm?: number | null;
  pbTtm?: number | null;
  evToEbitda?: number | null;
  // profitability + margins (decimal ratios, e.g. 0.20 = 20%)
  roeTtm?: number | null;
  roicTtm?: number | null;
  roaTtm?: number | null;
  grossMarginTtm?: number | null;
  operatingMarginTtm?: number | null;
  netMarginTtm?: number | null;
  // balance sheet
  debtToEquity?: number | null;
  currentRatio?: number | null;
  // growth (decimal ratios, e.g. 0.15 = 15%)
  revenueGrowthYoy?: number | null;
  revenueGrowth5y?: number | null;
  epsGrowthYoy?: number | null;
  epsGrowth5y?: number | null;
  // size + liquidity
  marketCapUsd?: number | null;
  avgDollarVolume30d?: number | null;
}

// ---------------------------------------------------------------------------
// Defaults + types
// ---------------------------------------------------------------------------

export interface DiscoveryWeights {
  news: number;
  earnings: number;
  insider: number;
  filings: number;
  momentum: number;
  sentiment: number;
  epsGrowth: number;
  revenueGrowth: number;
  margins: number;
  valuation: number;
  profitability: number;
  balanceSheet: number;
  liquidity: number;
  size: number;
}

export const DEFAULT_WEIGHTS: DiscoveryWeights = Object.freeze({
  // fundamentals — 55%
  epsGrowth: 0.12,
  revenueGrowth: 0.1,
  margins: 0.1,
  valuation: 0.1,
  profitability: 0.08,
  balanceSheet: 0.05,
  // quality — 10%
  liquidity: 0.05,
  size: 0.05,
  // attention/momentum — 35% (down from 100%)
  news: 0.08,
  earnings: 0.08,
  momentum: 0.07,
  insider: 0.07,
  filings: 0.03,
  sentiment: 0.02,
});

export interface SignalBreakdown {
  news: number;
  earnings: number;
  insider: number;
  filings: number;
  momentum: number;
  sentiment: number;
  epsGrowth: number;
  revenueGrowth: number;
  margins: number;
  valuation: number;
  profitability: number;
  balanceSheet: number;
  liquidity: number;
  size: number;
}

export interface ComputeDiscoveryScoreInput {
  articles: readonly Article[];
  earningsEvents: readonly MarketEvent[];
  insiderTxns: readonly InsiderTxn[];
  filings8K: readonly MarketEvent[];
  recentBars: readonly Bar[];
  sectorAvgReturn: number;
  tier3Articles: readonly Article[];
  metrics?: TickerMetricsLike | null;
  weights?: Partial<DiscoveryWeights>;
}

export interface DiscoveryScoreResult {
  score: number;
  breakdown: SignalBreakdown;
}

/** Composite display scale used by Discovery, Compare, and rotation gates. */
export const DISCOVERY_SCORE_SCALE = 10;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

/** Convert the roughly 0-10 composite into the legacy -1 to 1 signal scale. */
export function discoveryScoreToRotationSignal(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return clamp(score / DISCOVERY_SCORE_SCALE, -1, 1);
}

/** Compare two raw composites on the normalized rotation-delta scale. */
export function discoveryScoreDeltaForRotation(candidate: number, reference: number): number {
  if (!Number.isFinite(candidate) || !Number.isFinite(reference)) return 0;
  return clamp((candidate - reference) / DISCOVERY_SCORE_SCALE, -1, 1);
}

function num(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// ---------------------------------------------------------------------------
// Individual signals
// ---------------------------------------------------------------------------

/**
 * newsVolumeScore
 *
 * Count × tier weighting, then log10-scaled into [0, 10]. A "hot" ticker has
 * a lot of tier-1/2 coverage; a quiet one has 0. We deliberately clamp at 10
 * — a single ticker dominating the news (earnings + M&A day) shouldn't
 * saturate the whole composite.
 */
export function newsVolumeScore(articles: readonly Article[]): number {
  if (articles.length === 0) return 0;
  let weighted = 0;
  for (const a of articles) {
    const w = a.sourceTier === 1 ? 3 : a.sourceTier === 2 ? 2 : 1;
    weighted += w;
  }
  // log10(1 + x) so 0 → 0, 10 → ~1.04, 100 → ~2, 1000 → ~3, …
  // Multiply by 5 so 100 weighted ≈ 10 (saturation).
  const raw = Math.log10(1 + weighted) * 5;
  return clamp(raw, 0, 10);
}

/**
 * earningsSurpriseScore
 *
 * For earnings events in the last 30d: surprise = (actual − estimate) /
 * |estimate|. Sign-aware (beats positive, misses negative). We take the
 * most-recent event when multiple are present (a ticker rarely reports more
 * than once in a month but can if the sample spans a boundary).
 *
 * Clamped to [-1, 1]. A 10%+ surprise saturates the signal; anything beyond
 * is noise for our purposes.
 */
export function earningsSurpriseScore(events: readonly MarketEvent[]): number {
  if (events.length === 0) return 0;
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const recent = events
    .filter((e) => e.occurredAt.getTime() >= cutoff)
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
  if (recent.length === 0) return 0;

  const latest = recent[0];
  if (!latest || typeof latest.payload !== 'object' || latest.payload === null) {
    return 0;
  }
  const payload = latest.payload as Record<string, unknown>;
  const actual = Number(payload['actual'] ?? payload['epsActual'] ?? NaN);
  const estimate = Number(payload['estimate'] ?? payload['epsEstimate'] ?? NaN);
  if (!Number.isFinite(actual) || !Number.isFinite(estimate) || estimate === 0) {
    return 0;
  }
  const surprise = (actual - estimate) / Math.abs(estimate);
  // Scale: 10% surprise → ~1.0.
  return clamp(surprise * 10, -1, 1);
}

/**
 * insiderBuyScore
 *
 * Net USD value of Form-4 buys − sells in the last 90d, log-scaled.
 * Positive = net insider buying (bullish); negative = net selling.
 * Clamped to [-1, 1].
 */
export function insiderBuyScore(txns: readonly InsiderTxn[]): number {
  if (txns.length === 0) return 0;
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
  let net = 0;
  for (const t of txns) {
    if (t.transactionDate.getTime() < cutoff) continue;
    if (Number.isFinite(t.valueUsd)) net += t.valueUsd;
  }
  if (net === 0) return 0;
  const sign = Math.sign(net);
  // log10(1 + x) scaling: $100k → 5, $1M → 6, $10M → 7. Divide by 7 so $10M+
  // saturates the signal.
  const magnitude = Math.log10(1 + Math.abs(net)) / 7;
  return clamp(sign * magnitude, -1, 1);
}

/**
 * filingVelocityScore
 *
 * 8-K frequency in last 30d. 0 = baseline quiet, 3+ events = saturated.
 * Returned in [0, 1]; 8-Ks are information-rich but directionally agnostic,
 * so no negative range.
 */
export function filingVelocityScore(filings: readonly MarketEvent[]): number {
  if (filings.length === 0) return 0;
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const recent = filings.filter((f) => f.occurredAt.getTime() >= cutoff);
  return clamp(recent.length / 3, 0, 1);
}

/**
 * priceMomentumScore
 *
 * 20-day total return minus sector average, clamped to [-1, 1]. A ticker
 * leading its sector by 20+ pct gets saturated signal; matching the sector
 * is neutral.
 */
export function priceMomentumScore(recentBars: readonly Bar[], sectorAvgReturn: number): number {
  if (recentBars.length < 2) return 0;
  const sorted = [...recentBars].sort((a, b) => a.date.getTime() - b.date.getTime());
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last || first.close <= 0) return 0;
  const tickerReturn = (last.close - first.close) / first.close;
  const alpha = tickerReturn - (Number.isFinite(sectorAvgReturn) ? sectorAvgReturn : 0);
  // Saturate at 20% alpha.
  return clamp(alpha / 0.2, -1, 1);
}

/**
 * sentimentScore
 *
 * Tier-3 article volume × light polarity proxy. We use a very simple
 * keyword-pair ratio against a curated positive/negative list. Capped
 * contribution per spec — social is a tie-breaker, not a driver.
 *
 * Contribution is bounded to [-0.5, 0.5] so the composite can't be dragged
 * around by WSB sentiment during a hype cycle.
 */
const POSITIVE_KEYWORDS = [
  'beat',
  'beats',
  'surge',
  'surges',
  'soar',
  'soars',
  'rally',
  'upgrade',
  'bullish',
  'rocket',
  'moon',
  'breakout',
  'outperform',
  'buy',
];
const NEGATIVE_KEYWORDS = [
  'miss',
  'misses',
  'plunge',
  'plunges',
  'crash',
  'drop',
  'drops',
  'downgrade',
  'bearish',
  'tank',
  'tanks',
  'slump',
  'sell',
];

export function sentimentScore(tier3Articles: readonly Article[]): number {
  if (tier3Articles.length === 0) return 0;
  let pos = 0;
  let neg = 0;
  for (const a of tier3Articles) {
    // Prefer the post's native bull/bear tag (StockTwits) — the user's own call,
    // far cleaner than keyword-guessing. Keyword scan only for untagged posts.
    if (a.socialSentiment === 'Bullish') {
      pos++;
    } else if (a.socialSentiment === 'Bearish') {
      neg++;
    } else {
      const text = `${a.headline} ${a.body ?? ''}`.toLowerCase();
      for (const kw of POSITIVE_KEYWORDS) if (text.includes(kw)) pos++;
      for (const kw of NEGATIVE_KEYWORDS) if (text.includes(kw)) neg++;
    }
  }
  const total = pos + neg;
  if (total === 0) return 0;
  const polarity = (pos - neg) / total; // [-1, 1]
  // Scale by volume (log10) so a single hype post doesn't max out.
  const volume = Math.min(1, Math.log10(1 + tier3Articles.length) / 2);
  return clamp(polarity * volume * 0.5, -0.5, 0.5);
}

// ---------------------------------------------------------------------------
// Fundamentals signals — all in [0, 10]
// ---------------------------------------------------------------------------

/**
 * epsGrowthScore
 *
 * Combines YoY (recent acceleration) with 5y (durability). YoY contributes up
 * to ~6, 5y up to ~4; both must be positive to score well. Negative growth
 * pulls toward 0 but is floored.
 */
export function epsGrowthScore(metrics: TickerMetricsLike | null | undefined): number {
  if (!metrics) return 0;
  const yoy = num(metrics.epsGrowthYoy);
  const five = num(metrics.epsGrowth5y);
  if (yoy === null && five === null) return 0;
  // 25% YoY → ~6, 15% 5y → ~4. Saturating.
  const yoyScore = yoy === null ? 0 : clamp((yoy / 0.25) * 6, 0, 6);
  const fiveScore = five === null ? 0 : clamp((five / 0.15) * 4, 0, 4);
  return clamp(yoyScore + fiveScore, 0, 10);
}

/**
 * revenueGrowthScore
 *
 * Same shape as eps: YoY weighted slightly higher than 5y. Top-line growth is
 * the cleaner signal because earnings can be massaged via buybacks/cost cuts.
 */
export function revenueGrowthScore(metrics: TickerMetricsLike | null | undefined): number {
  if (!metrics) return 0;
  const yoy = num(metrics.revenueGrowthYoy);
  const five = num(metrics.revenueGrowth5y);
  if (yoy === null && five === null) return 0;
  // 20% YoY → ~6, 12% 5y → ~4.
  const yoyScore = yoy === null ? 0 : clamp((yoy / 0.2) * 6, 0, 6);
  const fiveScore = five === null ? 0 : clamp((five / 0.12) * 4, 0, 4);
  return clamp(yoyScore + fiveScore, 0, 10);
}

/**
 * marginScore
 *
 * Average across gross/op/net margins, scored against best-in-class thresholds
 * (gross 50%, op 20%, net 15%). Negative margins floor at 0.
 */
export function marginScore(metrics: TickerMetricsLike | null | undefined): number {
  if (!metrics) return 0;
  const gm = num(metrics.grossMarginTtm);
  const om = num(metrics.operatingMarginTtm);
  const nm = num(metrics.netMarginTtm);
  if (gm === null && om === null && nm === null) return 0;
  const parts: number[] = [];
  if (gm !== null) parts.push(clamp((gm / 0.5) * 10, 0, 10));
  if (om !== null) parts.push(clamp((om / 0.2) * 10, 0, 10));
  if (nm !== null) parts.push(clamp((nm / 0.15) * 10, 0, 10));
  if (parts.length === 0) return 0;
  return clamp(parts.reduce((a, b) => a + b, 0) / parts.length, 0, 10);
}

/**
 * valuationScore
 *
 * Inverse of P/E and P/S. Lower multiples score higher; negative or extreme
 * values yield 0 (loss-making or distressed). We use inverse rather than a
 * raw subtraction so the scaling is bounded without cliffs.
 */
export function valuationScore(metrics: TickerMetricsLike | null | undefined): number {
  if (!metrics) return 0;
  const pe = num(metrics.peTtm);
  const ps = num(metrics.psTtm);
  if (pe === null && ps === null) return 0;
  const parts: number[] = [];
  // P/E: 15 → 10, 30 → ~5, 60 → ~2.5; negative or > 100 → 0.
  if (pe !== null) {
    if (pe <= 0 || pe > 100) parts.push(0);
    else parts.push(clamp(150 / pe, 0, 10));
  }
  // P/S: 1.5 → 10, 5 → 3, 10 → 1.5; negative → 0.
  if (ps !== null) {
    if (ps <= 0 || ps > 50) parts.push(0);
    else parts.push(clamp(15 / ps, 0, 10));
  }
  if (parts.length === 0) return 0;
  return clamp(parts.reduce((a, b) => a + b, 0) / parts.length, 0, 10);
}

/**
 * profitabilityScore
 *
 * Average of ROE, ROIC, ROA scored against best-in-class thresholds
 * (ROE 20%, ROIC 15%, ROA 10%). Negative returns floor at 0.
 */
export function profitabilityScore(metrics: TickerMetricsLike | null | undefined): number {
  if (!metrics) return 0;
  const roe = num(metrics.roeTtm);
  const roic = num(metrics.roicTtm);
  const roa = num(metrics.roaTtm);
  if (roe === null && roic === null && roa === null) return 0;
  const parts: number[] = [];
  if (roe !== null) parts.push(clamp((roe / 0.2) * 10, 0, 10));
  if (roic !== null) parts.push(clamp((roic / 0.15) * 10, 0, 10));
  if (roa !== null) parts.push(clamp((roa / 0.1) * 10, 0, 10));
  if (parts.length === 0) return 0;
  return clamp(parts.reduce((a, b) => a + b, 0) / parts.length, 0, 10);
}

/**
 * balanceSheetScore
 *
 * Debt/equity below 1 and current ratio above 1.5 = healthy. Combines both
 * when present, falls back to whichever is available.
 */
export function balanceSheetScore(metrics: TickerMetricsLike | null | undefined): number {
  if (!metrics) return 0;
  const de = num(metrics.debtToEquity);
  const cr = num(metrics.currentRatio);
  if (de === null && cr === null) return 0;
  const parts: number[] = [];
  // D/E: 0 → 10, 1 → ~5, 3+ → 0. Negative D/E (negative equity) → 0.
  if (de !== null) {
    if (de < 0) parts.push(0);
    else parts.push(clamp(10 - (de * 10) / 3, 0, 10));
  }
  // Current ratio: 1.5+ → 10, 1.0 → ~5, <1 declines fast.
  if (cr !== null) {
    if (cr <= 0) parts.push(0);
    else if (cr >= 1.5) parts.push(10);
    else parts.push(clamp((cr / 1.5) * 10, 0, 10));
  }
  if (parts.length === 0) return 0;
  return clamp(parts.reduce((a, b) => a + b, 0) / parts.length, 0, 10);
}

/**
 * liquidityScore
 *
 * Avg daily dollar volume over 30d. $10M+ is institutional-tradeable (10),
 * $1M is concerning (~3), <$100k illiquid (0). Log-scaled.
 */
export function liquidityScore(metrics: TickerMetricsLike | null | undefined): number {
  if (!metrics) return 0;
  const adv = num(metrics.avgDollarVolume30d);
  if (adv === null || adv <= 0) return 0;
  // log10(1M) = 6 → 3, log10(10M) = 7 → ~7, log10(100M) = 8 → 10.
  const raw = (Math.log10(adv) - 5) * (10 / 3);
  return clamp(raw, 0, 10);
}

/**
 * sizeScore
 *
 * Saturating bonus for market cap. $1B+ caps the bonus — the signal exists
 * mainly to filter out micro-caps where the rest of the data is unreliable,
 * not to favor mega-caps over mid-caps.
 */
export function sizeScore(metrics: TickerMetricsLike | null | undefined): number {
  if (!metrics) return 0;
  const mc = num(metrics.marketCapUsd);
  if (mc === null || mc <= 0) return 0;
  // $100M → ~3, $500M → ~7, $1B+ → 10.
  const raw = (Math.log10(mc) - 8) * (10 / 1);
  return clamp(raw, 0, 10);
}

// ---------------------------------------------------------------------------
// Composite
// ---------------------------------------------------------------------------

/**
 * Compute all signals + the weighted composite.
 *
 * Weights default to DEFAULT_WEIGHTS but can be partially overridden via
 * `input.weights` (only the provided keys override; missing keys fall back
 * to the default).
 *
 * Composite = sum of (sub-score × weight). With weights summing to 1.0 and
 * sub-scores generally in [0, 10] (fundamentals) or smaller bounded ranges
 * (legacy attention/momentum signals, some [-1, 1]), the composite lands in
 * roughly [0, 10] for healthy tickers.
 */
export function computeDiscoveryScore(input: ComputeDiscoveryScoreInput): DiscoveryScoreResult {
  const weights: DiscoveryWeights = {
    ...DEFAULT_WEIGHTS,
    ...(input.weights ?? {}),
  };

  const metrics = input.metrics ?? null;

  const breakdown: SignalBreakdown = {
    news: newsVolumeScore(input.articles),
    earnings: earningsSurpriseScore(input.earningsEvents),
    insider: insiderBuyScore(input.insiderTxns),
    filings: filingVelocityScore(input.filings8K),
    momentum: priceMomentumScore(input.recentBars, input.sectorAvgReturn),
    sentiment: sentimentScore(input.tier3Articles),
    epsGrowth: epsGrowthScore(metrics),
    revenueGrowth: revenueGrowthScore(metrics),
    margins: marginScore(metrics),
    valuation: valuationScore(metrics),
    profitability: profitabilityScore(metrics),
    balanceSheet: balanceSheetScore(metrics),
    liquidity: liquidityScore(metrics),
    size: sizeScore(metrics),
  };

  const weighted =
    breakdown.news * weights.news +
    breakdown.earnings * weights.earnings +
    breakdown.insider * weights.insider +
    breakdown.filings * weights.filings +
    breakdown.momentum * weights.momentum +
    breakdown.sentiment * weights.sentiment +
    breakdown.epsGrowth * weights.epsGrowth +
    breakdown.revenueGrowth * weights.revenueGrowth +
    breakdown.margins * weights.margins +
    breakdown.valuation * weights.valuation +
    breakdown.profitability * weights.profitability +
    breakdown.balanceSheet * weights.balanceSheet +
    breakdown.liquidity * weights.liquidity +
    breakdown.size * weights.size;

  return { score: weighted, breakdown };
}

// ---------------------------------------------------------------------------
// Weight coercion — accepts the UserSettings.discoveryWeights JSON shape
// ---------------------------------------------------------------------------

/**
 * Coerce an unknown JSON blob into a Partial<DiscoveryWeights>. Invalid keys
 * and non-numeric values are dropped. Negative weights are clamped to 0 since
 * they'd invert a signal's polarity rather than de-emphasize it.
 */
export function coerceWeights(input: unknown): Partial<DiscoveryWeights> {
  if (typeof input !== 'object' || input === null) return {};
  const obj = input as Record<string, unknown>;
  const out: Partial<DiscoveryWeights> = {};
  const keys: (keyof DiscoveryWeights)[] = [
    'news',
    'earnings',
    'insider',
    'filings',
    'momentum',
    'sentiment',
    'epsGrowth',
    'revenueGrowth',
    'margins',
    'valuation',
    'profitability',
    'balanceSheet',
    'liquidity',
    'size',
  ];
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[k] = Math.max(0, v);
    }
  }
  return out;
}
