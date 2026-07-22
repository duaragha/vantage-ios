import type { Prisma, WebPushSubscription } from '@prisma/client';
import { prisma } from './client.js';

export interface SaveWebPushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
}

type SubscriptionClient = Pick<Prisma.TransactionClient, 'webPushSubscription'>;

export function saveWebPushSubscription(
  input: SaveWebPushSubscriptionInput,
  client: SubscriptionClient = prisma,
): Promise<WebPushSubscription> {
  const endpoint = input.endpoint.trim();
  const p256dh = input.p256dh.trim();
  const auth = input.auth.trim();
  if (!endpoint || !p256dh || !auth) throw new Error('complete web push subscription is required');

  return client.webPushSubscription.upsert({
    where: { endpoint },
    create: {
      endpoint,
      p256dh,
      auth,
      userAgent: input.userAgent?.slice(0, 500) ?? null,
    },
    update: {
      p256dh,
      auth,
      userAgent: input.userAgent?.slice(0, 500) ?? null,
      disabledAt: null,
      failureCount: 0,
    },
  });
}

export async function disableWebPushSubscription(
  endpoint: string,
  client: SubscriptionClient = prisma,
): Promise<boolean> {
  const result = await client.webPushSubscription.updateMany({
    where: { endpoint },
    data: { disabledAt: new Date() },
  });
  return result.count > 0;
}

export function countActiveWebPushSubscriptions(
  client: SubscriptionClient = prisma,
): Promise<number> {
  return client.webPushSubscription.count({ where: { disabledAt: null } });
}

export function listActiveWebPushSubscriptions(
  client: SubscriptionClient = prisma,
): Promise<WebPushSubscription[]> {
  return client.webPushSubscription.findMany({
    where: { disabledAt: null },
    orderBy: { updatedAt: 'desc' },
  });
}
