import {
  INCOME_RISK_PROFILES,
  MONTHLY_INCOME_TICKERS,
  incomeRiskAllows,
  type IncomeRiskKey,
} from '@vantage/core/goals/monthly-income';

export type DiscoveryLens = 'growth' | 'income' | 'catalyst' | 'quality' | 'raw';
export type DiscoveryRisk = IncomeRiskKey;

export interface ListingIdentity {
  ticker: string;
  exchange: string;
  currency: 'USD' | 'CAD';
}

export const LENS_OPTIONS: ReadonlyArray<{
  key: DiscoveryLens;
  label: string;
  note: string;
}> = [
  { key: 'growth', label: 'Growth', note: 'revenue, eps, margins, momentum' },
  { key: 'income', label: 'Income', note: 'yield quality, payout, balance sheet' },
  { key: 'catalyst', label: 'Catalyst', note: 'news, beats, insiders, filings' },
  { key: 'quality', label: 'Quality/value', note: 'profitability, valuation, balance sheet' },
  { key: 'raw', label: 'Raw score', note: 'saved discovery composite' },
];

export const RISK_OPTIONS: ReadonlyArray<{
  key: DiscoveryRisk;
  label: string;
  note: string;
}> = [
  {
    key: 'veryLow',
    label: 'Very low',
    note: 'safer income, quality balance sheets, lower beta',
  },
  { key: 'low', label: 'Low', note: 'quality first, modest yield or growth' },
  { key: 'moderate', label: 'Moderate', note: 'balanced upside and risk' },
  { key: 'high', label: 'High', note: 'higher yield, momentum, less cushion' },
  {
    key: 'aggressive',
    label: 'Aggressive',
    note: 'income hunts 8-9%+ yield, accepts more NAV/credit risk',
  },
];

export const RISK_SHORT: Record<DiscoveryRisk, string> = {
  veryLow: 'vl',
  low: 'low',
  moderate: 'mod',
  high: 'high',
  aggressive: 'agg',
};

export function isCanadianListing(listing: ListingIdentity): boolean {
  const ticker = listing.ticker.trim().toUpperCase();
  if (/\.(TO|NE|V)$/.test(ticker)) return true;

  const exchange = listing.exchange.trim().toUpperCase();
  return (
    listing.currency === 'CAD' ||
    exchange === 'TO' ||
    exchange === 'NE' ||
    exchange === 'V' ||
    exchange === 'TSX' ||
    exchange.includes('TORONTO STOCK') ||
    exchange.includes('TSX VENTURE') ||
    exchange.includes('CANADIAN NATIONAL') ||
    exchange.includes('CBOE CANADA') ||
    exchange.includes('NEO')
  );
}

export function canadianExchangeName(listing: ListingIdentity): string {
  const ticker = listing.ticker.trim().toUpperCase();
  const exchange = listing.exchange.trim().toUpperCase();
  if (
    ticker.endsWith('.NE') ||
    exchange === 'NE' ||
    exchange.includes('NEO') ||
    exchange.includes('CBOE CANADA')
  ) {
    return 'NEO / Cboe Canada';
  }
  if (ticker.endsWith('.V') || exchange === 'V' || exchange.includes('TSX VENTURE')) {
    return 'TSX-V';
  }
  return 'TSX';
}

export const SIGNAL_KEYS = [
  'epsGrowth',
  'revenueGrowth',
  'margins',
  'valuation',
  'profitability',
  'balanceSheet',
  'liquidity',
  'size',
  'momentum',
  'news',
  'earnings',
  'insider',
  'filings',
  'sentiment',
] as const;
export type SignalKey = (typeof SIGNAL_KEYS)[number];

export const SIGNAL_RANGES: Record<SignalKey, { min: number; max: number }> = {
  epsGrowth: { min: 0, max: 10 },
  revenueGrowth: { min: 0, max: 10 },
  margins: { min: 0, max: 10 },
  valuation: { min: 0, max: 10 },
  profitability: { min: 0, max: 10 },
  balanceSheet: { min: 0, max: 10 },
  liquidity: { min: 0, max: 10 },
  size: { min: 0, max: 10 },
  momentum: { min: -1, max: 1 },
  news: { min: 0, max: 10 },
  earnings: { min: -1, max: 1 },
  insider: { min: -1, max: 1 },
  filings: { min: 0, max: 1 },
  sentiment: { min: -0.5, max: 0.5 },
};

export const LENS_LABELS: Record<DiscoveryLens, string> = {
  growth: 'growth',
  income: 'income',
  catalyst: 'catalyst',
  quality: 'quality',
  raw: 'raw',
};

export const MOBILE_SIGNAL_KEYS: Record<Exclude<DiscoveryLens, 'raw'>, readonly SignalKey[]> = {
  growth: ['revenueGrowth', 'epsGrowth', 'margins', 'momentum'],
  income: ['profitability', 'balanceSheet', 'valuation', 'liquidity'],
  catalyst: ['news', 'earnings', 'insider', 'filings'],
  quality: ['profitability', 'margins', 'valuation', 'balanceSheet'],
};

export interface LensRow {
  ticker: string;
  name: string | null;
  score: number;
  scoreAvailable?: boolean;
  breakdown: Partial<Record<SignalKey, number>> | null;
  category?: string | null;
  curatedIncome?: boolean;
  incomeCadence?: 'monthly' | null;
  incomeRiskFloor?: IncomeRiskKey;
  incomeYieldEstimate?: number | null;
  incomeYieldSource?: 'metrics' | 'curated' | null;
  metrics?: {
    dividendPayoutRatio?: number | null;
    beta?: number | null;
  } | null;
  catalyst?: { kind: string; occurredAt: string } | null;
}

export function defaultDiscoveryLens(rows: readonly LensRow[]): DiscoveryLens {
  return rows.some((row) => row.scoreAvailable !== false) ? 'growth' : 'income';
}

export function hasDataForLens(row: LensRow, lens: DiscoveryLens): boolean {
  return lens === 'income' || row.scoreAvailable !== false;
}

export function resolveIncomeYieldEstimate(
  metricPercentagePoints: number | null | undefined,
  fallbackRatio: number | null | undefined,
): {
  estimate: number | null;
  source: 'metrics' | 'curated' | null;
} {
  if (
    typeof metricPercentagePoints === 'number' &&
    Number.isFinite(metricPercentagePoints) &&
    metricPercentagePoints > 0
  ) {
    return { estimate: metricPercentagePoints, source: 'metrics' };
  }
  if (typeof fallbackRatio === 'number' && Number.isFinite(fallbackRatio) && fallbackRatio > 0) {
    return { estimate: fallbackRatio, source: 'curated' };
  }
  return { estimate: null, source: null };
}

export function scoreForLens(row: LensRow, lens: DiscoveryLens, risk: DiscoveryRisk): number {
  if (lens === 'raw') return Number.isFinite(row.score) ? row.score : 0;

  const eps = signal10(row, 'epsGrowth');
  const revenue = signal10(row, 'revenueGrowth');
  const margins = signal10(row, 'margins');
  const valuation = signal10(row, 'valuation');
  const profitability = signal10(row, 'profitability');
  const balance = signal10(row, 'balanceSheet');
  const liquidity = signal10(row, 'liquidity');
  const size = signal10(row, 'size');
  const momentum = positiveSignal10(row, 'momentum');
  const news = signal10(row, 'news');
  const earnings = positiveSignal10(row, 'earnings');
  const insider = positiveSignal10(row, 'insider');
  const filings = signal10(row, 'filings');
  const sentiment = positiveSignal10(row, 'sentiment');
  const yieldScore = incomeYieldScore(row, risk);
  const payout = payoutScore(row);
  const catalyst = row.catalyst ? 10 : 0;
  const riskFit = riskFitScore(row, lens, risk);

  if (lens === 'growth') {
    const raw =
      eps * 0.24 +
      revenue * 0.24 +
      momentum * 0.14 +
      margins * 0.12 +
      profitability * 0.1 +
      earnings * 0.06 +
      news * 0.04 +
      liquidity * 0.04 +
      valuation * 0.02;
    const proof = Math.max(eps, revenue);
    const gate = proof >= 6 ? 1 : proof >= 4 ? 0.82 : proof >= 2 ? 0.62 : 0.42;
    return clamp(raw * gate * 0.88 + riskFit * 0.12, 0, 10);
  }

  if (lens === 'income') {
    const profile = INCOME_RISK_PROFILES[risk];
    const dividend = incomeYield(row);
    const highRiskIncome = risk === 'high' || risk === 'aggressive';
    const raw =
      yieldScore * (highRiskIncome ? 0.48 : 0.3) +
      payout * (highRiskIncome ? 0.1 : 0.18) +
      profitability * (highRiskIncome ? 0.1 : 0.15) +
      balance * (highRiskIncome ? 0.08 : 0.14) +
      valuation * 0.08 +
      liquidity * 0.06 +
      riskFit * 0.08 +
      revenue * 0.03 +
      eps * 0.03;
    const gate = dividend >= profile.minYield ? 1 : 0;
    return clamp(raw * gate, 0, 10);
  }

  if (lens === 'catalyst') {
    const raw =
      news * 0.22 +
      earnings * 0.18 +
      insider * 0.18 +
      momentum * 0.14 +
      filings * 0.1 +
      catalyst * 0.1 +
      sentiment * 0.05 +
      liquidity * 0.03;
    const activity = Math.max(news, earnings, insider, momentum, filings, catalyst);
    const gate = activity >= 5 ? 1 : activity >= 2 ? 0.7 : 0.4;
    return clamp(raw * gate * 0.88 + riskFit * 0.12, 0, 10);
  }

  const raw =
    profitability * 0.22 +
    margins * 0.18 +
    valuation * 0.18 +
    balance * 0.16 +
    liquidity * 0.1 +
    revenue * 0.06 +
    eps * 0.06 +
    size * 0.04;
  return clamp(raw * 0.9 + riskFit * 0.1, 0, 10);
}

export function buildReasons(row: LensRow, lens: DiscoveryLens, risk: DiscoveryRisk): string[] {
  const eps = signal10(row, 'epsGrowth');
  const revenue = signal10(row, 'revenueGrowth');
  const margins = signal10(row, 'margins');
  const valuation = signal10(row, 'valuation');
  const profitability = signal10(row, 'profitability');
  const balance = signal10(row, 'balanceSheet');
  const momentum = positiveSignal10(row, 'momentum');
  const news = signal10(row, 'news');
  const earnings = positiveSignal10(row, 'earnings');
  const insider = positiveSignal10(row, 'insider');
  const filings = signal10(row, 'filings');
  const yieldScore = incomeYieldScore(row, risk);
  const payout = payoutScore(row);
  const out: string[] = [];

  if (lens === 'growth') {
    if (eps >= 5) out.push(`eps growth ${Math.round(eps)}/10`);
    if (revenue >= 5) out.push(`revenue growth ${Math.round(revenue)}/10`);
    if (momentum >= 5) out.push('relative momentum');
    if (margins >= 6) out.push('strong margins');
    if (out.length === 0) out.push('growth proof is thin');
    if (Math.max(eps, revenue) < 3 && Math.max(valuation, profitability, balance) >= 6) {
      out.push('quality is carrying it');
    }
    return out;
  }

  if (lens === 'income') {
    const profile = INCOME_RISK_PROFILES[risk];
    const dividend = incomeYield(row);
    if (dividend > 0) out.push(`yield ${formatRatio(dividend)}`);
    else out.push('no dividend yield');
    if (isMonthlyIncomePayer(row)) out.push('monthly payer');
    if (row.incomeRiskFloor) out.push(`product risk: ${incomeRiskLabel(row.incomeRiskFloor)}`);
    if (row.curatedIncome) out.push('goal income pool');
    if (row.category === 'CoveredCall') out.push('covered-call income');
    else if (row.category === 'CashEquivalent') out.push('cash-like income');
    if (risk === 'aggressive') out.push(`agg target ${formatRatio(profile.targetYield)}+`);
    else if (risk === 'high') out.push(`high target ${formatRatio(profile.targetYield)}+`);
    if (payout >= 8) out.push('clean payout');
    else if (payout > 0 && payout < 5) out.push('payout needs checking');
    if (balance >= 6) out.push('balance sheet support');
    if (profitability >= 6) out.push('profitable payer');
    if (yieldScore < 2 && valuation >= 6) out.push('more value than income');
    return out;
  }

  if (lens === 'catalyst') {
    if (row.catalyst) out.push(`active ${humanCatalyst(row.catalyst.kind)}`);
    if (news >= 5) out.push('news intensity');
    if (earnings >= 5) out.push('earnings beat');
    if (insider >= 5) out.push('insider buying');
    if (filings >= 5) out.push('filing activity');
    if (momentum >= 5) out.push('price follow-through');
    if (out.length === 0) out.push('no live catalyst');
    return out;
  }

  if (lens === 'quality') {
    if (profitability >= 6) out.push('high profitability');
    if (margins >= 6) out.push('durable margins');
    if (valuation >= 6) out.push('valuation support');
    if (balance >= 6) out.push('strong balance sheet');
    if (out.length === 0) out.push('quality case is weak');
    return out;
  }

  return topSignals(row, 4);
}

function incomeRiskLabel(risk: IncomeRiskKey): string {
  return risk === 'veryLow' ? 'very low' : risk;
}

export function strongestLens(row: LensRow, risk: DiscoveryRisk): DiscoveryLens {
  const lenses: DiscoveryLens[] = ['growth', 'income', 'catalyst', 'quality'];
  return lenses.reduce((best, lens) =>
    scoreForLens(row, lens, risk) > scoreForLens(row, best, risk) ? lens : best,
  );
}

export function lensRead(row: LensRow, lens: DiscoveryLens, risk: DiscoveryRisk): string {
  if (lens === 'raw') {
    return `best fit is ${LENS_LABELS[strongestLens(row, risk)]}`;
  }
  return buildReasons(row, lens, risk).slice(0, 3).join(', ');
}

export function topSignals(row: LensRow, limit: number): string[] {
  if (!row.breakdown) return [];
  return SIGNAL_KEYS.map((key) => ({ key, score: signal10(row, key) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ key, score }) => `${prettySignalName(key)} ${Math.round(score)}/10`);
}

export function signal10(row: LensRow, key: SignalKey): number {
  const raw = row.breakdown?.[key] ?? 0;
  if (key === 'filings') return clamp(raw * 10, 0, 10);
  if (key === 'momentum' || key === 'earnings' || key === 'insider') {
    return clamp(((raw + 1) / 2) * 10, 0, 10);
  }
  if (key === 'sentiment') return clamp((raw + 0.5) * 10, 0, 10);
  return clamp(raw, 0, 10);
}

export function positiveSignal10(row: LensRow, key: SignalKey): number {
  const raw = row.breakdown?.[key] ?? 0;
  if (key === 'filings') return clamp(raw * 10, 0, 10);
  if (key === 'sentiment') return clamp((Math.max(raw, 0) / 0.5) * 10, 0, 10);
  if (key === 'momentum' || key === 'earnings' || key === 'insider') {
    return clamp(Math.max(raw, 0) * 10, 0, 10);
  }
  return clamp(raw, 0, 10);
}

export function passesLensRiskGate(
  row: LensRow,
  lens: DiscoveryLens,
  risk: DiscoveryRisk,
): boolean {
  if (lens !== 'income') return true;
  const profile = INCOME_RISK_PROFILES[risk];
  return (
    isMonthlyIncomePayer(row) &&
    incomeRiskAllows(risk, row.incomeRiskFloor ?? 'aggressive') &&
    incomeYield(row) >= profile.minYield
  );
}

export function incomeYieldScore(row: LensRow, risk: DiscoveryRisk): number {
  const yield_ = incomeYield(row);
  const profile = INCOME_RISK_PROFILES[risk];
  if (yield_ <= 0 || yield_ < profile.minYield) return 0;
  if (yield_ <= profile.targetYield) {
    return clamp(
      4 + ((yield_ - profile.minYield) / (profile.targetYield - profile.minYield)) * 6,
      4,
      10,
    );
  }
  if (risk === 'high' || risk === 'aggressive') return 10;
  if (yield_ <= profile.maxComfortYield) return 10;
  return clamp(10 - ((yield_ - profile.maxComfortYield) / profile.maxComfortYield) * 8, 3, 10);
}

export function riskFitScore(row: LensRow, lens: DiscoveryLens, risk: DiscoveryRisk): number {
  const beta = row.metrics?.beta ?? null;
  const size = signal10(row, 'size');
  const balance = signal10(row, 'balanceSheet');
  const liquidity = signal10(row, 'liquidity');
  const profitability = signal10(row, 'profitability');
  const momentum = positiveSignal10(row, 'momentum');
  const yield_ = incomeYield(row);

  const betaSafety =
    beta === null ? 5 : beta <= 0.8 ? 10 : beta <= 1 ? 8 : beta <= 1.25 ? 5 : beta <= 1.6 ? 2 : 0;
  const betaAggression =
    beta === null ? 5 : beta >= 1.4 ? 10 : beta >= 1.1 ? 7 : beta >= 0.8 ? 4 : 2;

  if (risk === 'veryLow') {
    return clamp(
      signal10(row, 'balanceSheet') * 0.28 +
        liquidity * 0.22 +
        profitability * 0.22 +
        betaSafety * 0.18 +
        size * 0.1,
      0,
      10,
    );
  }
  if (risk === 'low') {
    return clamp(
      signal10(row, 'balanceSheet') * 0.22 +
        liquidity * 0.2 +
        profitability * 0.22 +
        betaSafety * 0.16 +
        size * 0.1 +
        momentum * 0.1,
      0,
      10,
    );
  }
  if (risk === 'moderate') {
    return clamp(
      balance * 0.16 +
        liquidity * 0.18 +
        profitability * 0.18 +
        momentum * 0.18 +
        size * 0.1 +
        betaSafety * 0.1 +
        betaAggression * 0.1,
      0,
      10,
    );
  }
  if (risk === 'high') {
    const incomeBoost = lens === 'income' && yield_ >= 0.065 ? 10 : momentum;
    return clamp(
      momentum * 0.28 +
        incomeBoost * 0.22 +
        liquidity * 0.16 +
        profitability * 0.12 +
        betaAggression * 0.14 +
        balance * 0.08,
      0,
      10,
    );
  }
  const incomeBoost = lens === 'income' && yield_ >= 0.08 ? 10 : momentum;
  return clamp(
    incomeBoost * 0.34 +
      momentum * 0.24 +
      betaAggression * 0.18 +
      liquidity * 0.12 +
      profitability * 0.08 +
      balance * 0.04,
    0,
    10,
  );
}

export function isMonthlyIncomePayer(row: LensRow): boolean {
  if (row.incomeCadence === 'monthly') return true;
  if (MONTHLY_INCOME_TICKERS.has(row.ticker.toUpperCase())) return true;
  return /\bmonthly\b/i.test(row.name ?? '');
}

export function incomeCadenceLabel(row: LensRow): string {
  return isMonthlyIncomePayer(row) ? 'monthly' : 'unknown';
}

export function incomeYield(row: LensRow): number {
  const value = row.incomeYieldEstimate;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  // TickerMetrics stores Finnhub/Yahoo yields as percentage points (0.45 means
  // 0.45%). Curated estimates are decimal ratios (0.045 means 4.5%). The source
  // is therefore part of the unit contract; magnitude guessing breaks every
  // sub-1% dividend payer.
  if (row.incomeYieldSource === 'metrics') return value / 100;
  if (row.incomeYieldSource === 'curated') return value;
  return asRatio(value);
}

export function payoutScore(row: LensRow): number {
  const value = row.metrics?.dividendPayoutRatio;
  const payout = typeof value === 'number' && Number.isFinite(value) && value > 0 ? value / 100 : 0;
  if (payout <= 0) return 0;
  if (payout >= 0.35 && payout <= 0.75) return 10;
  if (payout < 0.35) return 7;
  if (payout <= 0.9) return 5;
  if (payout <= 1.1) return 2;
  return 0;
}

export function asRatio(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.abs(value) > 1 ? value / 100 : value;
}

export function prettySignalName(key: SignalKey): string {
  const labels: Record<SignalKey, string> = {
    epsGrowth: 'eps growth',
    revenueGrowth: 'revenue growth',
    margins: 'margins',
    valuation: 'valuation',
    profitability: 'profitability',
    balanceSheet: 'balance sheet',
    liquidity: 'liquidity',
    size: 'size',
    momentum: 'momentum',
    news: 'news',
    earnings: 'earnings',
    insider: 'insider',
    filings: 'filings',
    sentiment: 'sentiment',
  };
  return labels[key];
}

export function humanCatalyst(kind: string): string {
  const labels: Record<string, string> = {
    InsiderCluster: 'insider cluster',
    EarningsBeat: 'earnings beat',
    Material8K: 'material filing',
    AnalystUpgrade: 'analyst upgrade',
  };
  return labels[kind] ?? kind;
}

export function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function formatRatio(value: number): string {
  return `${(value * 100).toFixed(Math.abs(value) >= 0.1 ? 0 : 1)}%`;
}

export { MONTHLY_INCOME_TICKERS };
