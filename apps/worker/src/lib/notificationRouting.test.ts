import assert from 'node:assert/strict';
import { it } from 'node:test';
import { InsightKind } from '@vantage/db';
import type { NotificationPreferences } from '@vantage/db';
import {
  includeInsightInNotification,
  shouldQueueDigestNotification,
} from './notificationRouting.js';

const allOff: NotificationPreferences = {
  buySuggestions: false,
  rebalances: false,
  exceptionalOpportunities: false,
  scheduledDigests: false,
};

it('routes buy and rebalance cards independently from scheduled briefings', () => {
  assert.equal(
    includeInsightInNotification(
      { kind: InsightKind.BuySuggestion },
      { ...allOff, buySuggestions: true },
    ),
    true,
  );
  assert.equal(
    includeInsightInNotification({ kind: InsightKind.Rebalance }, { ...allOff, rebalances: true }),
    true,
  );
  assert.equal(
    includeInsightInNotification(
      { kind: InsightKind.Alert },
      { ...allOff, buySuggestions: true, rebalances: true },
    ),
    false,
  );
});

it('keeps a digest silent only when the briefing and every routed card are off', () => {
  assert.equal(shouldQueueDigestNotification(allOff, 0), false);
  assert.equal(shouldQueueDigestNotification(allOff, 1), true);
  assert.equal(shouldQueueDigestNotification({ ...allOff, scheduledDigests: true }, 0), true);
});
