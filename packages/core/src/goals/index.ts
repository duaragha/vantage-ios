export * from './securityPool.js';
export * from './monthlyIncome.js';
export * from './engine.js';
export * from './loaders.js';
export * from './dayTradeScanner.js';
// dcaProjection re-defines RiskTolerance/GoalStrategy as local unions (same
// values as engine.ts, kept self-contained like the rest of the engine). Export
// the DCA surface explicitly so those duplicate type names don't collide with
// engine.ts's re-exports; ContributionFrequency is new and unique here.
export {
  PERIODS_PER_YEAR,
  expectedAnnualReturn,
  expectedReturnForAllocation,
  futureValueAnnuity,
  solvePayment,
  projectGoal,
} from './dcaProjection.js';
export type { ContributionFrequency, DcaProjection, GlideMix } from './dcaProjection.js';
