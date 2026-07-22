import type { FastifyBaseLogger } from 'fastify';
import {
  AppNotificationDeliveryStatus,
  listActiveWebPushSubscriptions,
  prisma,
  type AppNotificationDelivery,
  type AppNotificationUrgency,
  type WebPushSubscription,
} from '@vantage/db';
import {
  isAppPushConfigured,
  sendAppPush,
  type AppPushFailure,
  type AppPushResult,
} from '@vantage/notify';
import {
  APP_NOTIFICATION_NOT_READY_DELAY_MS,
  appNotificationRetryDelayMs,
  shouldDeadLetterAppNotification,
} from '../lib/appNotificationDeliveryPolicy.js';

export interface AppNotificationDispatchResult {
  scanned: number;
  sent: number;
  retried: number;
  deferredNotReady: number;
  dead: number;
  recovered: number;
  subscriptionsDisabled: number;
}

const DEFAULT_LIMIT = 10;
const STALE_CLAIM_MS = 5 * 60 * 1000;

export async function dispatchAppNotifications(
  log: FastifyBaseLogger | Console = console,
  limit = DEFAULT_LIMIT,
): Promise<AppNotificationDispatchResult> {
  const now = new Date();
  const result: AppNotificationDispatchResult = {
    scanned: 0,
    sent: 0,
    retried: 0,
    deferredNotReady: 0,
    dead: 0,
    recovered: 0,
    subscriptionsDisabled: 0,
  };

  const recovered = await prisma.appNotificationDelivery.updateMany({
    where: {
      status: AppNotificationDeliveryStatus.Sending,
      lastAttemptAt: { lt: new Date(now.getTime() - STALE_CLAIM_MS) },
    },
    data: {
      status: AppNotificationDeliveryStatus.Pending,
      nextAttemptAt: now,
      lastError: 'recovered stale delivery claim',
    },
  });
  result.recovered = recovered.count;

  const expired = await prisma.appNotificationDelivery.updateMany({
    where: {
      status: AppNotificationDeliveryStatus.Pending,
      expiresAt: { lte: now },
    },
    data: {
      status: AppNotificationDeliveryStatus.Dead,
      lastError: 'delivery expired before it could be sent',
    },
  });
  result.dead += expired.count;

  const subscriptions = isAppPushConfigured() ? await listActiveWebPushSubscriptions() : [];
  if (!isAppPushConfigured() || subscriptions.length === 0) {
    const reason = isAppPushConfigured() ? 'no-active-subscription' : 'not-configured';
    const deferred = await prisma.appNotificationDelivery.updateMany({
      where: {
        status: AppNotificationDeliveryStatus.Pending,
        nextAttemptAt: { lte: now },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      data: {
        nextAttemptAt: new Date(now.getTime() + APP_NOTIFICATION_NOT_READY_DELAY_MS),
        lastError: reason,
      },
    });
    result.deferredNotReady = deferred.count;
    return result;
  }

  const deliveries = await prisma.appNotificationDelivery.findMany({
    where: {
      status: AppNotificationDeliveryStatus.Pending,
      nextAttemptAt: { lte: now },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }],
    take: Math.max(1, Math.min(limit, 100)),
  });
  result.scanned = deliveries.length;

  for (const delivery of deliveries) {
    const claimed = await prisma.appNotificationDelivery.updateMany({
      where: { id: delivery.id, status: AppNotificationDeliveryStatus.Pending },
      data: { status: AppNotificationDeliveryStatus.Sending, lastAttemptAt: new Date() },
    });
    if (claimed.count !== 1) continue;

    const sends = await Promise.all(
      subscriptions.map(async (subscription) => ({
        subscription,
        result: await sendDelivery(delivery, subscription),
      })),
    );
    let successes = 0;
    const failures: AppPushFailure[] = [];
    for (const send of sends) {
      if (send.result.ok) {
        successes += 1;
        await prisma.webPushSubscription.update({
          where: { id: send.subscription.id },
          data: { lastSuccessAt: new Date(), failureCount: 0 },
        });
      } else {
        failures.push(send.result);
        if (send.result.reason === 'gone') {
          await prisma.webPushSubscription.update({
            where: { id: send.subscription.id },
            data: { disabledAt: new Date(), failureCount: { increment: 1 } },
          });
          result.subscriptionsDisabled += 1;
        } else {
          await prisma.webPushSubscription.update({
            where: { id: send.subscription.id },
            data: { failureCount: { increment: 1 } },
          });
        }
      }
    }

    if (successes > 0) {
      await prisma.appNotificationDelivery.update({
        where: { id: delivery.id },
        data: {
          status: AppNotificationDeliveryStatus.Sent,
          attempts: { increment: 1 },
          sentAt: new Date(),
          lastError: failures.length > 0 ? describeFailures(failures) : null,
        },
      });
      result.sent += 1;
      log.info?.(
        { deliveryId: delivery.id, recipients: successes },
        'vantage app notification sent',
      );
      continue;
    }

    const onlyGone = failures.length > 0 && failures.every((failure) => failure.reason === 'gone');
    const attempts = delivery.attempts + (onlyGone ? 0 : 1);
    const failedAt = new Date();
    const dead =
      !onlyGone &&
      shouldDeadLetterAppNotification({ attempts, expiresAt: delivery.expiresAt, now: failedAt });
    const primaryReason = failures[0]?.reason ?? 'network';
    const error = failures.length > 0 ? describeFailures(failures) : 'no push result';

    await prisma.appNotificationDelivery.update({
      where: { id: delivery.id },
      data: {
        status: dead ? AppNotificationDeliveryStatus.Dead : AppNotificationDeliveryStatus.Pending,
        attempts,
        nextAttemptAt: new Date(
          failedAt.getTime() + appNotificationRetryDelayMs(primaryReason, Math.max(1, attempts)),
        ),
        lastError: error,
      },
    });
    if (dead) result.dead += 1;
    else if (onlyGone) result.deferredNotReady += 1;
    else result.retried += 1;
  }

  return result;
}

async function sendDelivery(
  delivery: AppNotificationDelivery,
  subscription: WebPushSubscription,
): Promise<AppPushResult> {
  const ttlSeconds = delivery.expiresAt
    ? Math.max(1, Math.floor((delivery.expiresAt.getTime() - Date.now()) / 1000))
    : 6 * 60 * 60;
  return sendAppPush(
    subscription,
    {
      title: delivery.title,
      body: delivery.body,
      url: delivery.url,
      ...(delivery.tag ? { tag: delivery.tag } : {}),
    },
    { ttlSeconds, urgency: readUrgency(delivery.urgency) },
  );
}

function readUrgency(value: string): AppNotificationUrgency {
  if (value === 'very-low' || value === 'low' || value === 'high') return value;
  return 'normal';
}

function describeFailures(failures: AppPushFailure[]): string {
  return failures
    .map((failure) =>
      [
        failure.reason,
        failure.statusCode === undefined ? null : `HTTP ${failure.statusCode}`,
        failure.description ?? null,
      ]
        .filter(Boolean)
        .join(': '),
    )
    .join(' | ')
    .slice(0, 1000);
}

export function runAppNotificationDispatch(
  log: FastifyBaseLogger | Console,
): Promise<AppNotificationDispatchResult> {
  return dispatchAppNotifications(log);
}

export async function hasPendingAppNotificationWork(): Promise<boolean> {
  if (!isAppPushConfigured()) return false;
  const [subscription, delivery] = await Promise.all([
    prisma.webPushSubscription.findFirst({ where: { disabledAt: null }, select: { id: true } }),
    prisma.appNotificationDelivery.findFirst({
      where: {
        status: {
          in: [AppNotificationDeliveryStatus.Pending, AppNotificationDeliveryStatus.Sending],
        },
      },
      select: { id: true },
    }),
  ]);
  return subscription !== null && delivery !== null;
}
