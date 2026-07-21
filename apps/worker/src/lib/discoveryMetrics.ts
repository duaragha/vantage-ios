import { percentagePointsToRatio } from '@vantage/core/units';
import type { TickerMetricsLike } from '@vantage/core';

/**
 * TickerMetrics stores provider percentages as percentage points, while the
 * discovery signal formulas use decimal ratios. Multiples, debt/equity,
 * liquidity, beta, and size are already in their native units.
 */
export function normalizeStoredDiscoveryMetrics(metrics: TickerMetricsLike): TickerMetricsLike {
  return {
    ...metrics,
    roeTtm: percentagePointsToRatio(metrics.roeTtm),
    roicTtm: percentagePointsToRatio(metrics.roicTtm),
    roaTtm: percentagePointsToRatio(metrics.roaTtm),
    grossMarginTtm: percentagePointsToRatio(metrics.grossMarginTtm),
    operatingMarginTtm: percentagePointsToRatio(metrics.operatingMarginTtm),
    netMarginTtm: percentagePointsToRatio(metrics.netMarginTtm),
    revenueGrowthYoy: percentagePointsToRatio(metrics.revenueGrowthYoy),
    revenueGrowth5y: percentagePointsToRatio(metrics.revenueGrowth5y),
    epsGrowthYoy: percentagePointsToRatio(metrics.epsGrowthYoy),
    epsGrowth5y: percentagePointsToRatio(metrics.epsGrowth5y),
  };
}
