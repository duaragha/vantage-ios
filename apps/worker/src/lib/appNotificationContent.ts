import { InsightKind, type Insight, type QueueAppNotificationInput } from '@vantage/db';
import type { DigestKind } from '@vantage/core';

type NotificationInsight = Pick<Insight, 'id' | 'kind' | 'title' | 'body'>;

export function buildDigestAppNotification(
  kind: DigestKind | 'discovery',
  summary: string,
  insights: ReadonlyArray<NotificationInsight>,
): Omit<QueueAppNotificationInput, 'dedupeKey' | 'expiresAt'> {
  if (insights.length === 1) {
    return buildRecommendationAppNotification(insights[0]!);
  }

  if (insights.length > 1) {
    return {
      title: `${insights.length} new Vantage recommendations`,
      body: compact(insights.map((insight) => insight.title).join(' · '), 220),
      url: '/insights',
      tag: `digest-${kind}`,
      urgency: 'normal',
    };
  }

  return {
    title: digestTitle(kind),
    body: compact(summary || 'Your latest Vantage briefing is ready.', 220),
    url: '/insights',
    tag: `digest-${kind}`,
    urgency: 'low',
  };
}

export function buildRecommendationAppNotification(
  insight: NotificationInsight,
): Omit<QueueAppNotificationInput, 'dedupeKey' | 'expiresAt'> {
  return {
    title: insightTitle(insight.kind),
    body: compact(`${insight.title}. ${insight.body}`, 220),
    url: `/insights/${insight.id}`,
    tag: `insight-${insight.id}`,
    urgency: 'normal',
  };
}

export function buildExceptionalOpportunityNotification(
  insight: NotificationInsight,
): Omit<QueueAppNotificationInput, 'dedupeKey' | 'expiresAt'> {
  return {
    title: 'Exceptional opportunity',
    body: compact(`${insight.title}. ${insight.body}`, 220),
    url: `/insights/${insight.id}`,
    tag: `insight-${insight.id}`,
    urgency: 'high',
  };
}

function insightTitle(kind: InsightKind): string {
  if (kind === InsightKind.BuySuggestion) return 'New buy recommendation';
  if (kind === InsightKind.Rebalance) return 'Rebalance recommendation';
  return 'New Vantage insight';
}

function digestTitle(kind: DigestKind | 'discovery'): string {
  if (kind === 'morning') return 'Morning briefing';
  if (kind === 'evening') return 'Evening briefing';
  if (kind === 'monthly') return 'Monthly allocation';
  if (kind === 'weekly') return 'Weekly deep dive';
  return 'Discovery briefing';
}

function compact(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}
