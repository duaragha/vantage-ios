import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_TELEGRAM_DELIVERY_ATTEMPTS,
  TELEGRAM_NOT_CONFIGURED_DELAY_MS,
  shouldDeadLetterTelegramDelivery,
  telegramRetryDelayMs,
} from './telegramDeliveryPolicy.js';

describe('telegram delivery retry policy', () => {
  it('backs transient failures off exponentially with a one-hour cap', () => {
    assert.equal(telegramRetryDelayMs('network', 1), 60_000);
    assert.equal(telegramRetryDelayMs('server-error', 3), 240_000);
    assert.equal(telegramRetryDelayMs('rate-limited', 20), 3_600_000);
  });

  it('does not churn while Telegram is unconfigured', () => {
    assert.equal(telegramRetryDelayMs('not-configured', 1), TELEGRAM_NOT_CONFIGURED_DELAY_MS);
  });

  it('dead-letters expired or repeatedly failing messages', () => {
    const now = new Date('2026-07-17T12:00:00.000Z');
    assert.equal(shouldDeadLetterTelegramDelivery({ attempts: 1, expiresAt: now, now }), true);
    assert.equal(
      shouldDeadLetterTelegramDelivery({
        attempts: MAX_TELEGRAM_DELIVERY_ATTEMPTS,
        expiresAt: null,
        now,
      }),
      true,
    );
    assert.equal(
      shouldDeadLetterTelegramDelivery({
        attempts: MAX_TELEGRAM_DELIVERY_ATTEMPTS - 1,
        expiresAt: new Date(now.getTime() + 1),
        now,
      }),
      false,
    );
  });
});
