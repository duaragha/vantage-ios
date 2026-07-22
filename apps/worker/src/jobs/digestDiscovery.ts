/**
 * Discovery digest dispatch worker — Phase 15.
 *
 * Wraps `buildDiscoveryDigest` from @vantage/core and queues the matching
 * Vantage app notification.
 *
 * Runs weekly (Saturday 10am America/Toronto) and on-demand via
 * POST /jobs/digest/discovery.
 */

import type { FastifyBaseLogger } from 'fastify';
import { buildDiscoveryDigest, type BuildDiscoveryDigestResult } from '@vantage/core';
import { getNotificationPreferences, prisma, queueAppNotification } from '@vantage/db';
import { sendSelfAlert } from '@vantage/notify';
import { buildDigestAppNotification } from '../lib/appNotificationContent.js';
import {
  includeInsightInNotification,
  shouldQueueDigestNotification,
} from '../lib/notificationRouting.js';

export interface DiscoveryDispatchResult {
  insightsCreated: number;
  insightsIds: number[];
  summary: string;
  failedSources: string[];
  tokens: BuildDiscoveryDigestResult['tokens'];
  llmCallIds: number[];
  appNotification: { ok: true; queued: boolean; deliveryId: number | null };
}

export async function runDiscoveryDigest(
  log: FastifyBaseLogger | Console = console,
): Promise<DiscoveryDispatchResult> {
  let digest: BuildDiscoveryDigestResult;
  try {
    digest = await buildDiscoveryDigest({ log });
  } catch (err) {
    void sendSelfAlert('error', 'Discovery digest build failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  // Re-hydrate the persisted insights so app notifications use the canonical
  // title, body, and kind written by the discovery pipeline.
  const hydrated =
    digest.insights.length > 0
      ? await prisma.insight.findMany({
          where: { id: { in: digest.insights.map((i) => i.id) } },
          select: {
            id: true,
            kind: true,
            title: true,
            body: true,
            confidence: true,
            actionJson: true,
          },
        })
      : [];

  const preferences = await getNotificationPreferences();
  const notificationInsights = hydrated.filter((insight) =>
    includeInsightInNotification(insight, preferences),
  );
  const shouldQueue = shouldQueueDigestNotification(preferences, notificationInsights.length);

  const content = buildDigestAppNotification('discovery', digest.summary, notificationInsights);

  const identity =
    digest.insights.length > 0
      ? `insights:${digest.insights.map((insight) => insight.id).join(',')}`
      : digest.llmCallIds.length > 0
        ? `llm:${digest.llmCallIds.join(',')}`
        : `hour:${new Date().toISOString().slice(0, 13)}`;
  const delivery = shouldQueue
    ? await queueAppNotification({
        dedupeKey: `app:digest:discovery:${identity}`,
        ...content,
        expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      })
    : null;

  const base = {
    insightsCreated: digest.insights.length,
    insightsIds: digest.insights.map((i) => i.id),
    summary: digest.summary,
    failedSources: digest.failedSources,
    tokens: digest.tokens,
    llmCallIds: digest.llmCallIds,
  } as const;

  log.info?.(
    {
      deliveryId: delivery?.id ?? null,
      notificationInsights: notificationInsights.length,
      insights: digest.insights.length,
    },
    delivery
      ? 'discovery digest queued for Vantage app delivery'
      : 'discovery digest app notification muted by settings',
  );
  return {
    ...base,
    appNotification: { ok: true, queued: delivery !== null, deliveryId: delivery?.id ?? null },
  };
}
