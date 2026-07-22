import assert from 'node:assert/strict';
import { it } from 'node:test';
import { InsightKind } from '@vantage/db';
import {
  buildDigestAppNotification,
  buildExceptionalOpportunityNotification,
} from './appNotificationContent.js';

it('deep-links a single buy recommendation', () => {
  const payload = buildDigestAppNotification('monthly', 'summary', [
    { id: 42, kind: InsightKind.BuySuggestion, title: 'Buy 2 SHOP', body: 'Strong setup' },
  ]);
  assert.equal(payload.title, 'New buy recommendation');
  assert.equal(payload.url, '/insights/42');
  assert.equal(payload.urgency, 'normal');
});

it('marks exceptional opportunities as high urgency', () => {
  const payload = buildExceptionalOpportunityNotification({
    id: 7,
    kind: InsightKind.BuySuggestion,
    title: 'Buy 4 XYZ',
    body: 'Three catalysts aligned',
  });
  assert.equal(payload.title, 'Exceptional opportunity');
  assert.equal(payload.url, '/insights/7');
  assert.equal(payload.urgency, 'high');
});
