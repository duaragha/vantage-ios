import type { DiscoveryWeights, SignalBreakdown } from '@vantage/core/discover/signals';
import { SIGNAL_KEYS, prettySignalName, type SignalKey } from './discoveryLens';

export const LIVE_PRICE_MAX_AGE_MS = 10 * 60_000;

export interface SelectedPrice {
  price: number;
  ageSeconds: number;
  isLive: boolean;
}

export interface PriceCandidate {
  price: number;
  fetchedAt: Date;
}

export interface CloseCandidate {
  close: number;
  date: Date;
}

export function selectPriceSource(
  nowMs: number,
  live: PriceCandidate | null,
  close: CloseCandidate | null,
): SelectedPrice | null {
  if (live && nowMs - live.fetchedAt.getTime() < LIVE_PRICE_MAX_AGE_MS) {
    if (Number.isFinite(live.price) && live.price > 0) {
      return {
        price: live.price,
        ageSeconds: Math.max(0, Math.floor((nowMs - live.fetchedAt.getTime()) / 1000)),
        isLive: true,
      };
    }
  }
  if (close && Number.isFinite(close.close) && close.close > 0) {
    return {
      price: close.close,
      ageSeconds: Math.max(0, Math.floor((nowMs - close.date.getTime()) / 1000)),
      isLive: false,
    };
  }
  return null;
}

export function normalizeSignalBreakdown(raw: unknown): SignalBreakdown | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const out: Partial<Record<SignalKey, number>> = {};
  for (const key of SIGNAL_KEYS) {
    const value = obj[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    out[key] = value;
  }
  return out as SignalBreakdown;
}

export interface SwapExplanationSide {
  ticker: string;
  score: number;
  breakdown: SignalBreakdown | null;
}

export function explainSwapSignals(
  held: SwapExplanationSide,
  buy: SwapExplanationSide,
  weights: DiscoveryWeights,
): string {
  const delta = buy.score - held.score;
  if (!held.breakdown || !buy.breakdown) {
    return `${buy.ticker} scores ${buy.score.toFixed(2)} vs ${held.ticker} at ${held.score.toFixed(2)} (delta ${delta.toFixed(2)}).`;
  }

  const deltas = SIGNAL_KEYS.map((key) => ({
    key,
    heldValue: held.breakdown?.[key] ?? 0,
    buyValue: buy.breakdown?.[key] ?? 0,
    contribution: ((buy.breakdown?.[key] ?? 0) - (held.breakdown?.[key] ?? 0)) * weights[key],
  })).sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

  const reasons = deltas
    .filter((item) => Math.abs(item.contribution) >= 0.01)
    .slice(0, 3)
    .map(
      ({ key, heldValue, buyValue, contribution }) =>
        `${prettySignalName(key)} ${formatSignalValue(key, buyValue)} vs ${formatSignalValue(key, heldValue)} (${signed(contribution)} score)`,
    );
  const tail = reasons.length > 0 ? `; led by ${reasons.join(', ')}` : '';
  return `${buy.ticker} scores ${buy.score.toFixed(2)} vs ${held.ticker} at ${held.score.toFixed(2)} (delta ${delta.toFixed(2)})${tail}.`;
}

export interface ResearchBar {
  close: number;
  high: number;
  low: number;
}

export interface WindowStats {
  r30: number | null;
  r6mo: number | null;
  r1y: number | null;
  high52: number | null;
  low52: number | null;
  fromHighPct: number | null;
}

export function computeWindowStats(barsNewestFirst: readonly ResearchBar[]): WindowStats | null {
  const current = barsNewestFirst[0]?.close;
  if (current === undefined || !Number.isFinite(current) || current <= 0) return null;

  const pickPct = (index: number): number | null => {
    const reference = barsNewestFirst[index]?.close;
    if (reference === undefined || !Number.isFinite(reference) || reference <= 0) return null;
    return ((current - reference) / reference) * 100;
  };

  const rangeBars = barsNewestFirst.slice(0, 252);
  const highs = rangeBars
    .map((bar) => bar.high)
    .filter((value) => Number.isFinite(value) && value > 0);
  const lows = rangeBars
    .map((bar) => bar.low)
    .filter((value) => Number.isFinite(value) && value > 0);
  const high52 = highs.length > 0 ? Math.max(...highs) : null;
  const low52 = lows.length > 0 ? Math.min(...lows) : null;

  return {
    r30: pickPct(21),
    r6mo: pickPct(125),
    r1y: pickPct(251),
    high52,
    low52,
    fromHighPct: high52 === null ? null : ((current - high52) / high52) * 100,
  };
}

export function subtractBenchmarkReturn(
  tickerReturn: number | null,
  benchmarkReturn: number | null,
): number | null {
  if (tickerReturn === null || benchmarkReturn === null) return null;
  return tickerReturn - benchmarkReturn;
}

export function collapseDailyScoreTrend(
  points: ReadonlyArray<{ score: number; computedAt: Date }>,
): number[] {
  const latestByDay = new Map<string, { score: number; at: number }>();
  for (const point of points) {
    if (!Number.isFinite(point.score)) continue;
    const at = point.computedAt.getTime();
    const key = point.computedAt.toISOString().slice(0, 10);
    const current = latestByDay.get(key);
    if (!current || at > current.at) latestByDay.set(key, { score: point.score, at });
  }
  return [...latestByDay.values()]
    .sort((a, b) => a.at - b.at)
    .slice(-30)
    .map((point) => point.score);
}

function formatSignalValue(key: SignalKey, value: number): string {
  if (key === 'momentum' || key === 'earnings' || key === 'insider' || key === 'sentiment') {
    return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
  }
  return value.toFixed(1);
}

function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
}
