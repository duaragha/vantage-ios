/**
 * @vantage/db — public surface.
 *
 * Re-exports the Prisma client singleton, all generated types/enums, and the
 * domain-specific CRUD helpers. Consumers should import from here, not from
 * @prisma/client directly, so the singleton contract isn't bypassed.
 */

export { prisma } from './client.js';
export type { DbClient } from './client.js';

// Generated Prisma types + enums (values + types re-exported for consumers).
export {
  AccountType,
  Confidence,
  ContributionFrequency,
  EventKind,
  GoalStrategy,
  GoalType,
  InsightKind,
  InsightStatus,
  Prisma,
  RiskTolerance,
  SecurityCategory,
  TelegramDeliveryStatus,
  ThesisStatus,
  TradingStyle,
  UserFeedback,
} from '@prisma/client';
export type {
  Account,
  AnalystRecommendation,
  Article,
  BacktestRun,
  ChatMessage,
  ChatThread,
  DailyBar,
  DiscoveryScore,
  FundamentalsSnapshot,
  Goal,
  GoalPosition,
  GoalSnapshot,
  Insight,
  InsiderTransaction,
  JobRun,
  LivePrice,
  LlmCall,
  MarketEvent,
  PassCooldown,
  Position,
  Thesis,
  ThesisEvaluation,
  TickerMetrics,
  TickerUniverse,
  TelegramDelivery,
  UserSettings,
  Watchlist,
} from '@prisma/client';

// Domain CRUD helpers.
export * from './analystRecommendations.js';
export * from './articles.js';
export * from './dailyBars.js';
export * from './discoveryScores.js';
export * from './events.js';
export * from './insights.js';
export * from './insiderTransactions.js';
export * from './passCooldown.js';
export * from './positions.js';
export * from './semanticSearch.js';
export * from './settings.js';
export * from './theses.js';
export * from './tickerUniverse.js';
export * from './telegramDeliveries.js';
export * from './watchlist.js';
export * from './zonedTime.js';
