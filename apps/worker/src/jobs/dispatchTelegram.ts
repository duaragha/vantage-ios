import type { FastifyBaseLogger } from 'fastify';
import {
  prisma,
  TelegramDeliveryStatus,
  type TelegramDelivery,
  type TelegramParseMode,
} from '@vantage/db';
import {
  isTelegramConfigured,
  sendMessage,
  type TelegramFailure,
  type TelegramResult,
} from '@vantage/notify';
import {
  shouldDeadLetterTelegramDelivery,
  TELEGRAM_NOT_CONFIGURED_DELAY_MS,
  telegramRetryDelayMs,
} from '../lib/telegramDeliveryPolicy.js';

export interface TelegramDispatchResult {
  scanned: number;
  sent: number;
  retried: number;
  deferredNotConfigured: number;
  dead: number;
  recovered: number;
}

const DEFAULT_LIMIT = 10;
const STALE_CLAIM_MS = 5 * 60 * 1000;

export async function dispatchTelegramDeliveries(
  log: FastifyBaseLogger | Console = console,
  limit = DEFAULT_LIMIT,
): Promise<TelegramDispatchResult> {
  const now = new Date();
  const result: TelegramDispatchResult = {
    scanned: 0,
    sent: 0,
    retried: 0,
    deferredNotConfigured: 0,
    dead: 0,
    recovered: 0,
  };

  const recovered = await prisma.telegramDelivery.updateMany({
    where: {
      status: TelegramDeliveryStatus.Sending,
      lastAttemptAt: { lt: new Date(now.getTime() - STALE_CLAIM_MS) },
    },
    data: {
      status: TelegramDeliveryStatus.Pending,
      nextAttemptAt: now,
      lastError: 'recovered stale delivery claim',
    },
  });
  result.recovered = recovered.count;

  const expired = await prisma.telegramDelivery.updateMany({
    where: {
      status: TelegramDeliveryStatus.Pending,
      expiresAt: { lte: now },
    },
    data: {
      status: TelegramDeliveryStatus.Dead,
      lastError: 'delivery expired before it could be sent',
    },
  });
  result.dead += expired.count;

  // Unconfigured short-circuit: every send would end in `not-configured`, so
  // defer the whole due queue in one write instead of claiming rows one by
  // one. Rows stay Pending (durable-queue contract) with attempts untouched,
  // exactly as the per-row path would have left them.
  if (!isTelegramConfigured()) {
    const deferred = await prisma.telegramDelivery.updateMany({
      where: {
        status: TelegramDeliveryStatus.Pending,
        nextAttemptAt: { lte: now },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      data: {
        nextAttemptAt: new Date(now.getTime() + TELEGRAM_NOT_CONFIGURED_DELAY_MS),
        lastError: 'not-configured',
      },
    });
    result.deferredNotConfigured = deferred.count;
    if (deferred.count > 0) {
      log.warn?.(
        { deferred: deferred.count },
        'telegram dispatch deferred: Telegram is not configured',
      );
    }
    return result;
  }

  const deliveries = await prisma.telegramDelivery.findMany({
    where: {
      status: TelegramDeliveryStatus.Pending,
      nextAttemptAt: { lte: now },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }],
    take: Math.max(1, Math.min(limit, 100)),
  });
  result.scanned = deliveries.length;

  for (const delivery of deliveries) {
    const claimedAt = new Date();
    const claimed = await prisma.telegramDelivery.updateMany({
      where: { id: delivery.id, status: TelegramDeliveryStatus.Pending },
      data: {
        status: TelegramDeliveryStatus.Sending,
        lastAttemptAt: claimedAt,
      },
    });
    if (claimed.count !== 1) continue;

    const sendResult = await sendDelivery(delivery);
    if (sendResult.ok) {
      await prisma.telegramDelivery.update({
        where: { id: delivery.id },
        data: {
          status: TelegramDeliveryStatus.Sent,
          attempts: { increment: 1 },
          sentAt: new Date(),
          messageId: sendResult.messageId,
          lastError: null,
        },
      });
      result.sent += 1;
      log.info?.(
        { deliveryId: delivery.id, messageId: sendResult.messageId },
        'telegram delivery sent',
      );
      continue;
    }

    const isUnconfigured = sendResult.reason === 'not-configured';
    const attempts = delivery.attempts + (isUnconfigured ? 0 : 1);
    const failedAt = new Date();
    const dead =
      !isUnconfigured &&
      shouldDeadLetterTelegramDelivery({
        attempts,
        expiresAt: delivery.expiresAt,
        now: failedAt,
      });
    const error = describeFailure(sendResult);

    await prisma.telegramDelivery.update({
      where: { id: delivery.id },
      data: {
        status: dead ? TelegramDeliveryStatus.Dead : TelegramDeliveryStatus.Pending,
        attempts,
        nextAttemptAt: new Date(
          failedAt.getTime() + telegramRetryDelayMs(sendResult.reason, Math.max(1, attempts)),
        ),
        lastError: error,
      },
    });

    if (dead) {
      result.dead += 1;
      log.error?.({ deliveryId: delivery.id, attempts, error }, 'telegram delivery dead-lettered');
    } else if (isUnconfigured) {
      result.deferredNotConfigured += 1;
      log.warn?.(
        { deliveryId: delivery.id },
        'telegram delivery deferred: Telegram is not configured',
      );
    } else {
      result.retried += 1;
      log.warn?.(
        { deliveryId: delivery.id, attempts, error },
        'telegram delivery scheduled for retry',
      );
    }
  }

  return result;
}

async function sendDelivery(delivery: TelegramDelivery): Promise<TelegramResult> {
  try {
    return await sendMessage(delivery.text, {
      ...(isParseMode(delivery.parseMode) ? { parseMode: delivery.parseMode } : {}),
      disableNotification: delivery.disableNotification,
      disableWebPagePreview: delivery.disableWebPagePreview,
    });
  } catch (err) {
    return {
      ok: false,
      reason: 'network',
      description: err instanceof Error ? err.message : String(err),
    };
  }
}

function isParseMode(value: string | null): value is TelegramParseMode {
  return value === 'Markdown' || value === 'MarkdownV2' || value === 'HTML';
}

function describeFailure(failure: TelegramFailure): string {
  return [
    failure.reason,
    failure.status === undefined ? null : `HTTP ${failure.status}`,
    failure.description ?? null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(': ');
}

export async function runTelegramDispatch(
  log: FastifyBaseLogger | Console,
): Promise<TelegramDispatchResult> {
  return dispatchTelegramDeliveries(log);
}

/**
 * Cron precheck. While configured, any Pending or Sending row is work (due
 * checks, expiry, stale-claim recovery). While unconfigured, nothing is
 * deliverable and the config cannot change without a process restart, so skip
 * without even querying — expiry marking and stale-claim recovery ride the
 * 15-minute runJob heartbeat sweep, well inside the 48h/7d expiry windows.
 */
export async function hasPendingTelegramWork(): Promise<boolean> {
  if (!isTelegramConfigured()) return false;
  const pending = await prisma.telegramDelivery.findFirst({
    where: { status: { in: [TelegramDeliveryStatus.Pending, TelegramDeliveryStatus.Sending] } },
    select: { id: true },
  });
  return pending !== null;
}
