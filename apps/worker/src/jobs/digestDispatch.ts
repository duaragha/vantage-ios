/**
 * Digest dispatch worker.
 *
 * Thin handler: call buildDigest() in @vantage/core and queue a durable
 * Vantage app notification according to the user's routing preferences.
 */

import type { FastifyBaseLogger } from 'fastify';
import { buildDigest, type DigestKind, type DigestResult } from '@vantage/core';
import { getNotificationPreferences, queueAppNotification } from '@vantage/db';
import { sendSelfAlert } from '@vantage/notify';
import { buildDigestAppNotification } from '../lib/appNotificationContent.js';
import {
  includeInsightInNotification,
  shouldQueueDigestNotification,
} from '../lib/notificationRouting.js';

export interface DigestDispatchResult {
  kind: DigestKind;
  insightsCreated: number;
  insightsIds: number[];
  summary: string;
  failedSources: string[];
  tokens: DigestResult['tokens'];
  llmCallIds: number[];
  appNotification: { ok: true; queued: boolean; deliveryId: number | null };
}

/**
 * Build the digest and persist its app notification. The dispatcher owns the
 * network attempt so transient failures cannot lose a completed digest.
 */
export async function runDigest(
  kind: DigestKind,
  log: FastifyBaseLogger | Console = console,
): Promise<DigestDispatchResult> {
  let digest: DigestResult;
  try {
    digest = await buildDigest(kind, { log });
  } catch (err) {
    // Digest build failed — fire a self-alert then rethrow so runJob records
    // the failure as a JobRun row.
    void sendSelfAlert('error', `Digest build failed: ${kind}`, {
      kind,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  const preferences = await getNotificationPreferences();
  const notificationInsights = digest.insights.filter((insight) =>
    includeInsightInNotification(insight, preferences),
  );
  const shouldQueue = shouldQueueDigestNotification(preferences, notificationInsights.length);
  const content = buildDigestAppNotification(kind, digest.summary, notificationInsights);

  const delivery = shouldQueue
    ? await queueAppNotification({
        dedupeKey: `app:${digestDeliveryKey(kind, digest)}`,
        ...content,
        expiresAt: new Date(Date.now() + digestExpiryMs(kind)),
      })
    : null;

  const baseResult = {
    kind,
    insightsCreated: digest.insights.length,
    insightsIds: digest.insights.map((i) => i.id),
    summary: digest.summary,
    failedSources: digest.failedSources,
    tokens: digest.tokens,
    llmCallIds: digest.llmCallIds,
  } as const;

  log.info?.(
    {
      kind,
      deliveryId: delivery?.id ?? null,
      notificationInsights: notificationInsights.length,
      insights: digest.insights.length,
      failedSources: digest.failedSources,
    },
    delivery
      ? 'digest queued for Vantage app delivery'
      : 'digest app notification muted by settings',
  );
  return {
    ...baseResult,
    appNotification: { ok: true, queued: delivery !== null, deliveryId: delivery?.id ?? null },
  };
}

function digestDeliveryKey(kind: DigestKind, digest: DigestResult): string {
  const identity =
    digest.insights.length > 0
      ? `insights:${digest.insights.map((insight) => insight.id).join(',')}`
      : digest.llmCallIds.length > 0
        ? `llm:${digest.llmCallIds.join(',')}`
        : `hour:${new Date().toISOString().slice(0, 13)}`;
  return `digest:${kind}:${identity}`;
}

function digestExpiryMs(kind: DigestKind): number {
  if (kind === 'morning') return 12 * 60 * 60 * 1000;
  if (kind === 'evening') return 18 * 60 * 60 * 1000;
  return 3 * 24 * 60 * 60 * 1000;
}
