import type { AppNotificationDelivery, Prisma } from '@prisma/client';
import { prisma } from './client.js';

export type AppNotificationUrgency = 'very-low' | 'low' | 'normal' | 'high';

export interface QueueAppNotificationInput {
  dedupeKey: string;
  title: string;
  body: string;
  url: string;
  tag?: string;
  urgency?: AppNotificationUrgency;
  expiresAt?: Date;
}

type DeliveryClient = Pick<Prisma.TransactionClient, 'appNotificationDelivery'>;

/** Persist one logical app notification exactly once. */
export function queueAppNotification(
  input: QueueAppNotificationInput,
  client: DeliveryClient = prisma,
): Promise<AppNotificationDelivery> {
  const dedupeKey = input.dedupeKey.trim();
  const title = input.title.trim();
  const body = input.body.trim();
  const url = input.url.trim();
  if (!dedupeKey) throw new Error('app notification dedupeKey is required');
  if (!title) throw new Error('app notification title is required');
  if (!body) throw new Error('app notification body is required');
  if (!url.startsWith('/')) throw new Error('app notification url must be an app-relative path');

  return client.appNotificationDelivery.upsert({
    where: { dedupeKey },
    create: {
      dedupeKey,
      title: title.slice(0, 120),
      body: body.slice(0, 500),
      url,
      tag: input.tag?.slice(0, 120) ?? null,
      urgency: input.urgency ?? 'normal',
      expiresAt: input.expiresAt ?? null,
    },
    update: {},
  });
}
