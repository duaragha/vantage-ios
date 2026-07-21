/**
 * Backtest type surface — shared across engine, strategies, metrics, and
 * persistence. Deliberately narrow: the backtest is self-contained and does
 * not import Prisma types here (the engine adds those).
 */

export type BacktestStrategy =
  | 'monthly-allocation'
  | 'rebalance-only'
  | 'catalyst-driven';

export interface BacktestCaps {
  singlePositionCapPct: number;
  sectorCapPct: number;
}

export interface BacktestConfig {
  startDate: Date;
  endDate: Date;
  strategy: BacktestStrategy;
  initialCashUsd: number;
  monthlyBudgetUsd: number;
  caps: BacktestCaps;
  seedPositions?: ReadonlyArray<SeedPosition>;
  candidateUniverse?: ReadonlyArray<string>;
  /**
   * Optional sector map: ticker → sector string. When omitted the sector cap is
   * a no-op (backtests with unsectored candidates still run; they just don't
   * enforce sectorCapPct).
   */
  sectors?: Record<string, string | null>;
  /**
   * Phase 17.10 — Holding period in trading days for the catalyst-driven
   * strategy. Each catalyst-event-triggered buy is held for this many trading
   * days, then sold at the close on day N. Default 30. Ignored for other
   * strategies.
   */
  holdingDays?: number;
  /**
   * Phase 17.10 — Per-day cap on catalyst-driven buys, mirrors the live
   * UserSettings.catalystMaxPerDay. Default 2.
   */
  catalystMaxPerDay?: number;
}

export interface SeedPosition {
  ticker: string;
  shares: number;
  avgCost: number;
}

export interface BacktestPosition {
  ticker: string;
  shares: number;
  avgCost: number;
}

export interface BacktestTrade {
  date: Date;
  ticker: string;
  kind: 'buy' | 'trim' | 'exit';
  shares: number;
  price: number;
  dollars: number;
  rationale: string;
}

export interface BacktestSnapshotPosition {
  ticker: string;
  shares: number;
  valueUsd: number;
}

export interface BacktestSnapshot {
  date: Date;
  cashUsd: number;
  positions: BacktestSnapshotPosition[];
  totalValueUsd: number;
}

export interface BacktestEquityPoint {
  date: Date;
  valueUsd: number;
  spyValueUsd: number;
}

export interface BacktestResult {
  entries: BacktestTrade[];
  exits: BacktestTrade[];
  monthlySnapshots: BacktestSnapshot[];
  finalValueUsd: number;
  totalReturnPct: number;
  spyReturnPct: number;
  maxDrawdownPct: number;
  cagr: number;
  sharpeApprox?: number;
  /** Dense daily equity curve for charting. SPY is normalized to initial cash. */
  equityCurve: BacktestEquityPoint[];
  /** Persisted BacktestRun.id (null when engine called without `persist`). */
  backtestRunId: number | null;
}
