import type { Prisma, TelegramDelivery } from '@prisma/client';
import { prisma } from './client.js';

export type TelegramParseMode = 'Markdown' | 'MarkdownV2' | 'HTML';

export interface QueueTelegramDeliveryInput {
  dedupeKey: string;
  text: string;
  parseMode?: TelegramParseMode;
  disableNotification?: boolean;
  disableWebPagePreview?: boolean;
  expiresAt?: Date;
}

type TelegramDeliveryClient = Pick<Prisma.TransactionClient, 'telegramDelivery'>;

/**
 * Persist one logical Telegram message exactly once. An existing row is left
 * untouched, including its delivery status, so a replay cannot resurrect a
 * sent or expired notification.
 */
export async function queueTelegramDelivery(
  input: QueueTelegramDeliveryInput,
  client: TelegramDeliveryClient = prisma,
): Promise<TelegramDelivery> {
  const dedupeKey = input.dedupeKey.trim();
  if (!dedupeKey) throw new Error('telegram delivery dedupeKey is required');
  if (!input.text.trim()) throw new Error('telegram delivery text is required');

  return client.telegramDelivery.upsert({
    where: { dedupeKey },
    create: {
      dedupeKey,
      text: input.text,
      parseMode: input.parseMode ?? null,
      disableNotification: input.disableNotification ?? false,
      disableWebPagePreview: input.disableWebPagePreview ?? true,
      expiresAt: input.expiresAt ?? null,
    },
    update: {},
  });
}
