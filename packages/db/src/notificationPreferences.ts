import type { Prisma } from '@prisma/client';
import { prisma } from './client.js';

export interface NotificationPreferences {
  buySuggestions: boolean;
  rebalances: boolean;
  exceptionalOpportunities: boolean;
  scheduledDigests: boolean;
}

export const DEFAULT_NOTIFICATION_PREFERENCES: Readonly<NotificationPreferences> = Object.freeze({
  buySuggestions: true,
  rebalances: true,
  exceptionalOpportunities: true,
  scheduledDigests: true,
});

type SettingsClient = Pick<Prisma.TransactionClient, 'userSettings'>;

/**
 * Read the single-user notification routing switches. Missing settings keep
 * the historic all-on behavior so a fresh migration cannot silently suppress
 * an alert before the seed row exists.
 */
export async function getNotificationPreferences(
  client: SettingsClient = prisma,
): Promise<NotificationPreferences> {
  const row = await client.userSettings.findUnique({
    where: { id: 1 },
    select: {
      notifyBuySuggestions: true,
      notifyRebalances: true,
      notifyExceptionalOpportunities: true,
      notifyScheduledDigests: true,
    },
  });

  if (!row) return { ...DEFAULT_NOTIFICATION_PREFERENCES };
  return {
    buySuggestions: row.notifyBuySuggestions,
    rebalances: row.notifyRebalances,
    exceptionalOpportunities: row.notifyExceptionalOpportunities,
    scheduledDigests: row.notifyScheduledDigests,
  };
}
