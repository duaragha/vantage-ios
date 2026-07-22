/**
 * Bounded retention windows for operational tables.
 *
 * Product data (positions, insights, theses, bars, universe, backtests) is
 * never touched. This policy covers only operational exhaust, keeping every
 * failure long enough to debug and every consumer's read window intact:
 *
 *   - JobRun succeeded: 14d (ops page + audit soak read <48h; the newest run
 *     per name is always kept regardless of age so "last run" stays truthful)
 *   - JobRun failed: 90d (failures are the useful history)
 *   - TelegramDelivery Sent: 30d; Dead: 90d (pending/sending never touched)
 *   - AppNotificationDelivery Sent: 30d; Dead: 90d (pending/sending never
 *     touched)
 *   - LlmCall: 365d (spend caps read daily/monthly windows; a year preserves
 *     any plausible cost analysis)
 *   - MarketEvent processed: 180d (calendar/discovery badges read 30d)
 *   - tier-3 social Articles: 60d, only when no Insight or ChatMessage cites
 *     them (discovery sentiment reads 30d; citations must never dangle)
 *   - unprocessed catalyst-kind MarketEvents older than 48h are marked
 *     processed (the catalyst engine's evaluation window is 24h, and the
 *     alert dispatcher deliberately no longer drains these kinds)
 */

export interface RetentionCutoffs {
  jobRunSucceededBefore: Date;
  jobRunFailedBefore: Date;
  telegramSentBefore: Date;
  telegramDeadBefore: Date;
  appNotificationSentBefore: Date;
  appNotificationDeadBefore: Date;
  llmCallBefore: Date;
  marketEventProcessedBefore: Date;
  tier3ArticleBefore: Date;
  catalystEventDrainBefore: Date;
}

export const RETENTION_DAYS = {
  jobRunSucceeded: 14,
  jobRunFailed: 90,
  telegramSent: 30,
  telegramDead: 90,
  appNotificationSent: 30,
  appNotificationDead: 90,
  llmCall: 365,
  marketEventProcessed: 180,
  tier3Article: 60,
} as const;

export const CATALYST_DRAIN_HOURS = 48;

/** Per-table delete ceiling per run so a first sweep cannot stall the DB. */
export const MAX_DELETES_PER_TABLE = 20_000;

const DAY_MS = 24 * 3600 * 1000;

export function retentionCutoffs(now: Date): RetentionCutoffs {
  const daysAgo = (days: number): Date => new Date(now.getTime() - days * DAY_MS);
  return {
    jobRunSucceededBefore: daysAgo(RETENTION_DAYS.jobRunSucceeded),
    jobRunFailedBefore: daysAgo(RETENTION_DAYS.jobRunFailed),
    telegramSentBefore: daysAgo(RETENTION_DAYS.telegramSent),
    telegramDeadBefore: daysAgo(RETENTION_DAYS.telegramDead),
    appNotificationSentBefore: daysAgo(RETENTION_DAYS.appNotificationSent),
    appNotificationDeadBefore: daysAgo(RETENTION_DAYS.appNotificationDead),
    llmCallBefore: daysAgo(RETENTION_DAYS.llmCall),
    marketEventProcessedBefore: daysAgo(RETENTION_DAYS.marketEventProcessed),
    tier3ArticleBefore: daysAgo(RETENTION_DAYS.tier3Article),
    catalystEventDrainBefore: new Date(now.getTime() - CATALYST_DRAIN_HOURS * 3600 * 1000),
  };
}
