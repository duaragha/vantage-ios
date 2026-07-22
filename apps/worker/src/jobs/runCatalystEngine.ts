/**
 * Catalyst engine cron handler — Phase 17.5.
 *
 * Wraps `evaluateCatalysts()` from @vantage/core, then dispatches a
 * durable Telegram delivery per emitted Insight. The outbox dispatcher owns
 * network retries, so a provider outage cannot lose a catalyst alert.
 *
 * Cron registration lives in cron.ts and checks every five minutes. A cheap
 * pending-event gate keeps empty ticks to one indexed lookup, while a new
 * qualifying catalyst reaches this engine within roughly five minutes.
 */

import type { FastifyBaseLogger } from 'fastify';
import {
  CATALYST_KINDS,
  evaluateCatalysts,
  formatCatalystAlertForTelegram,
  type CatalystResult,
} from '@vantage/core';
import { getNotificationPreferences, prisma, queueTelegramDelivery } from '@vantage/db';

export interface RunCatalystEngineResult extends CatalystResult {
  telegramQueued: number;
  telegramFormatFallbacks: number;
}

function deepLinkBase(): string {
  return process.env['DASHBOARD_BASE_URL'] ?? 'http://localhost:3000';
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

  const dispatch: Pick<RunCatalystEngineResult, 'telegramQueued' | 'telegramFormatFallbacks'> = {
    telegramQueued: 0,
    telegramFormatFallbacks: 0,
  };

  if (result.suggestionIds.length === 0) {
    return { ...result, ...dispatch };
  }

  const preferences = await getNotificationPreferences();
  if (!preferences.exceptionalOpportunities) {
    logger.info?.(
      { suggestionIds: result.suggestionIds },
      '[catalyst] exceptional-opportunity notifications muted by settings',
    );
    return { ...result, ...dispatch };
  }

  // Re-load the persisted Insights with their actionJson so the formatter
  // can render the catalyst metadata.
  const insights = await prisma.insight.findMany({
    where: { id: { in: result.suggestionIds } },
  });
  const linkBase = deepLinkBase();

  for (const insight of insights) {
    let message: string;
    let parseMode: 'Markdown' | undefined = 'Markdown';
    try {
      message = formatCatalystAlertForTelegram(insight, {
        deepLinkBase: linkBase,
      });
    } catch (err) {
      dispatch.telegramFormatFallbacks += 1;
      parseMode = undefined;
      message = `Vantage catalyst alert\n${insight.title}\n${insight.body}\n${linkBase.replace(/\/$/, '')}/insights/${insight.id}`;
      logger.warn?.(
        {
          insightId: insight.id,
          err: err instanceof Error ? err.message : err,
        },
        '[catalyst] formatter threw — queued plain-text fallback',
      );
    }

    const delivery = await queueTelegramDelivery({
      dedupeKey: `insight:${insight.id}`,
      text: message,
      ...(parseMode ? { parseMode } : {}),
      disableWebPagePreview: true,
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
    });
    dispatch.telegramQueued += 1;
    logger.info?.(
      { insightId: insight.id, deliveryId: delivery.id },
      '[catalyst] Telegram delivery queued',
    );
  }

  return { ...result, ...dispatch };
}
