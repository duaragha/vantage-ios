import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  APP_NOTIFICATION_NOT_READY_DELAY_MS,
  MAX_APP_NOTIFICATION_ATTEMPTS,
  appNotificationRetryDelayMs,
  shouldDeadLetterAppNotification,
} from './appNotificationDeliveryPolicy.js';

describe('app notification delivery retry policy', () => {
  it('retries transient push failures quickly with a one-hour cap', () => {
    assert.equal(appNotificationRetryDelayMs('network', 1), 30_000);
    assert.equal(appNotificationRetryDelayMs('server-error', 3), 120_000);
    assert.equal(appNotificationRetryDelayMs('rate-limited', 20), 3_600_000);
  });

  it('waits for configuration or a replacement device subscription', () => {
    assert.equal(
      appNotificationRetryDelayMs('not-configured', 1),
      APP_NOTIFICATION_NOT_READY_DELAY_MS,
    );
    assert.equal(appNotificationRetryDelayMs('gone', 1), APP_NOTIFICATION_NOT_READY_DELAY_MS);
  });

  it('dead-letters expired or repeatedly failing deliveries', () => {
    const now = new Date('2026-07-22T12:00:00.000Z');
    assert.equal(shouldDeadLetterAppNotification({ attempts: 1, expiresAt: now, now }), true);
    assert.equal(
      shouldDeadLetterAppNotification({
        attempts: MAX_APP_NOTIFICATION_ATTEMPTS,
        expiresAt: null,
        now,
      }),
      true,
    );
  });
});
