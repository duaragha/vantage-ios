/**
 * User-approved monthly income universe and the shared risk/yield contract
 * used by Goals, Discovery, and Compare.
 *
 * Provider fundamentals expose yield but not a dependable distribution
 * cadence or product-risk classification, so those two facts stay explicit.
 */
export type IncomeRiskKey = 'veryLow' | 'low' | 'moderate' | 'high' | 'aggressive';

export interface IncomeRiskProfile {
  minYield: number;
  targetYield: number;
  maxComfortYield: number;
}

export const INCOME_RISK_PROFILES: Readonly<Record<IncomeRiskKey, IncomeRiskProfile>> = {
  veryLow: { minYield: 0.025, targetYield: 0.04, maxComfortYield: 0.055 },
  low: { minYield: 0.03, targetYield: 0.045, maxComfortYield: 0.065 },
  moderate: { minYield: 0.05, targetYield: 0.065, maxComfortYield: 0.085 },
  high: { minYield: 0.065, targetYield: 0.08, maxComfortYield: 0.105 },
  aggressive: { minYield: 0.08, targetYield: 0.095, maxComfortYield: 0.16 },
};

export const GOAL_INCOME_RISK_KEYS = {
  VeryLow: 'veryLow',
  Low: 'low',
  Moderate: 'moderate',
  High: 'high',
  Aggressive: 'aggressive',
} as const satisfies Record<string, IncomeRiskKey>;

const INCOME_RISK_RANK: Readonly<Record<IncomeRiskKey, number>> = {
  veryLow: 1,
  low: 2,
  moderate: 3,
  high: 4,
  aggressive: 5,
};

export function incomeRiskAllows(selected: IncomeRiskKey, minimum: IncomeRiskKey): boolean {
  return INCOME_RISK_RANK[selected] >= INCOME_RISK_RANK[minimum];
}

export const MONTHLY_INCOME_TICKERS: ReadonlySet<string> = new Set([
  'CASH.TO',
  'CBIL.TO',
  'PSA.TO',
  'ZMMK.TO',
  'XSB.TO',
  'VSB.TO',
  'ZAG.TO',
  'XBB.TO',
  'VDY.TO',
  'ZDV.TO',
  'XEI.TO',
  'QQQI',
  'SPYI',
  'JEPI',
  'JEPQ',
  'ZWB.TO',
  'ZWU.TO',
  'ZWC.TO',
  'HMAX.TO',
  'HDIV.TO',
  'O',
  'MAIN',
  'STAG',
  'ADC',
  'EPR',
  'GOOD',
  'GLAD',
  'GAIN',
  'PFLT',
  'PSEC',
  'AGNC',
  'ARR',
  'HRZN',
  'LAND',
  'LTC',
  'HYG',
  'JNK',
]);

/**
 * Monthly payers outside the curated goal-security pool. These estimates are
 * a labeled degraded-data fallback only; live TickerMetrics yield wins when
 * available. The risk floor prevents a low-risk lens from mistaking a modest
 * REIT yield or a leveraged mortgage-REIT payout for a safe income product.
 */
export const MONTHLY_INCOME_FALLBACKS: Readonly<
  Record<string, { expectedYield: number; riskFloor: IncomeRiskKey }>
> = {
  STAG: { expectedYield: 0.04, riskFloor: 'moderate' },
  ADC: { expectedYield: 0.04, riskFloor: 'moderate' },
  EPR: { expectedYield: 0.07, riskFloor: 'high' },
  GOOD: { expectedYield: 0.08, riskFloor: 'aggressive' },
  GLAD: { expectedYield: 0.09, riskFloor: 'aggressive' },
  GAIN: { expectedYield: 0.07, riskFloor: 'high' },
  PFLT: { expectedYield: 0.1, riskFloor: 'aggressive' },
  PSEC: { expectedYield: 0.13, riskFloor: 'aggressive' },
  AGNC: { expectedYield: 0.14, riskFloor: 'aggressive' },
  ARR: { expectedYield: 0.14, riskFloor: 'aggressive' },
  HRZN: { expectedYield: 0.11, riskFloor: 'aggressive' },
  LAND: { expectedYield: 0.04, riskFloor: 'moderate' },
  LTC: { expectedYield: 0.06, riskFloor: 'moderate' },
};

export function isMonthlyIncomeTicker(ticker: string): boolean {
  return MONTHLY_INCOME_TICKERS.has(ticker.trim().toUpperCase());
}

export function monthlyIncomeFallback(
  ticker: string,
): { expectedYield: number; riskFloor: IncomeRiskKey } | null {
  return MONTHLY_INCOME_FALLBACKS[ticker.trim().toUpperCase()] ?? null;
}
