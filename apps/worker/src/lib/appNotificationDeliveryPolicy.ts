import type { AppPushFailureReason } from '@vantage/notify';

export const MAX_APP_NOTIFICATION_ATTEMPTS = 12;
export const APP_NOTIFICATION_NOT_READY_DELAY_MS = 15 * 60 * 1000;

export function appNotificationRetryDelayMs(
  reason: AppPushFailureReason,
  attempts: number,
): number {
  if (reason === 'not-configured' || reason === 'gone') {
    return APP_NOTIFICATION_NOT_READY_DELAY_MS;
  }
  if (reason === 'client-error') return 60 * 60 * 1000;
  const safeAttempts = Math.max(1, attempts);
  return Math.min(60 * 60 * 1000, 30 * 1000 * 2 ** (safeAttempts - 1));
}

export function shouldDeadLetterAppNotification(input: {
  attempts: number;
  expiresAt: Date | null;
  now: Date;
}): boolean {
  if (input.expiresAt && input.expiresAt.getTime() <= input.now.getTime()) return true;
  return input.attempts >= MAX_APP_NOTIFICATION_ATTEMPTS;
}
