import type { TelegramFailureReason } from '@vantage/notify';

export const MAX_TELEGRAM_DELIVERY_ATTEMPTS = 12;
export const TELEGRAM_NOT_CONFIGURED_DELAY_MS = 15 * 60 * 1000;

/** Delay after a failed network/API attempt. Attempts are one-indexed. */
export function telegramRetryDelayMs(reason: TelegramFailureReason, attempts: number): number {
  if (reason === 'not-configured') return TELEGRAM_NOT_CONFIGURED_DELAY_MS;
  if (reason === 'client-error') return 60 * 60 * 1000;

  const safeAttempts = Math.max(1, attempts);
  return Math.min(60 * 60 * 1000, 60 * 1000 * 2 ** (safeAttempts - 1));
}

export function shouldDeadLetterTelegramDelivery(input: {
  attempts: number;
  expiresAt: Date | null;
  now: Date;
}): boolean {
  if (input.expiresAt && input.expiresAt.getTime() <= input.now.getTime()) return true;
  return input.attempts >= MAX_TELEGRAM_DELIVERY_ATTEMPTS;
}
