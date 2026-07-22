import { InsightKind, type Insight, type NotificationPreferences } from '@vantage/db';

/**
 * Decide whether an insight belongs in a phone notification. Recommendation
 * cards have their own switches; every other digest card follows the
 * scheduled-briefing switch.
 */
export function includeInsightInNotification(
  insight: Pick<Insight, 'kind'>,
  preferences: NotificationPreferences,
): boolean {
  if (insight.kind === InsightKind.BuySuggestion) return preferences.buySuggestions;
  if (insight.kind === InsightKind.Rebalance) return preferences.rebalances;
  return preferences.scheduledDigests;
}

/** A digest can be silent while still delivering enabled recommendation cards. */
export function shouldQueueDigestNotification(
  preferences: NotificationPreferences,
  includedInsightCount: number,
): boolean {
  return preferences.scheduledDigests || includedInsightCount > 0;
}
