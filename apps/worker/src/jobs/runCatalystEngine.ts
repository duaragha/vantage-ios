/**
 * Catalyst engine cron handler — Phase 17.5.
 *
 * Wraps `evaluateCatalysts()` from @vantage/core, then queues a durable
 * high-priority Vantage app notification per emitted Insight.
 *
 * Cron registration lives in cron.ts and checks every five minutes. A cheap
 * pending-event gate keeps empty ticks to one indexed lookup, while a new
 * qualifying catalyst reaches this engine within roughly five minutes.
 */

import type { FastifyBaseLogger } from 'fastify';
import { CATALYST_KINDS, evaluateCatalysts, type CatalystResult } from '@vantage/core';
import { getNotificationPreferences, prisma, queueAppNotification } from '@vantage/db';
import { buildExceptionalOpportunityNotification } from '../lib/appNotificationContent.js';

export interface RunCatalystEngineResult extends CatalystResult {
  appNotificationsQueued: number;
}

/** Cheap cron gate: do no catalyst work until an eligible event is waiting. */
export async function hasPendingCatalystWork(now = new Date()): Promise<boolean> {
  const settings = await prisma.userSettings.findUnique({
    where: { id: 1 },
    select: { catalystEnabled: true },
  });
  if (settings?.catalystEnabled === false) return false;

  const pending = await prisma.marketEvent.findFirst({
    where: {
      kind: { in: [...CATALYST_KINDS] },
      processedAt: null,
      occurredAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
    },
    select: { id: true },
  });
  return pending !== null;
}

export async function runCatalystEngine(
  logger: FastifyBaseLogger | Console = console,
): Promise<RunCatalystEngineResult> {
  const result = await evaluateCatalysts({ log: logger });

  const dispatch: Pick<RunCatalystEngineResult, 'appNotificationsQueued'> = {
    appNotificationsQueued: 0,
  };

  if (result.suggestionIds.length === 0) {
    return { ...result, ...dispatch };
  }

  const preferences = await getNotificationPreferences();
  if (!preferences.exceptionalOpportunities) {
    logger.info?.(
      { suggestionIds: result.suggestionIds },
      '[catalyst] exceptional-opportunity app notifications muted by settings',
    );
    return { ...result, ...dispatch };
  }

  // Re-load the persisted Insights with their actionJson so the formatter
  // can render the catalyst metadata.
  const insights = await prisma.insight.findMany({
    where: { id: { in: result.suggestionIds } },
  });

  for (const insight of insights) {
    const delivery = await queueAppNotification({
      dedupeKey: `app:insight:${insight.id}`,
      ...buildExceptionalOpportunityNotification(insight),
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
    });
    dispatch.appNotificationsQueued += 1;
    logger.info?.(
      { insightId: insight.id, deliveryId: delivery.id },
      '[catalyst] Vantage app notification queued',
    );
  }

  return { ...result, ...dispatch };
}
