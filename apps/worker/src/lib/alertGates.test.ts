import assert from 'node:assert/strict';
import { it } from 'node:test';
import { EventKind } from '@vantage/db';
import {
  alertDailyLlmCap,
  DEFAULT_ALERT_DAILY_LLM_CAP,
  EVENT_FRESHNESS_HOURS,
  freshnessCutoff,
  isEventFresh,
  MAX_EVENT_AGE_HOURS,
} from './alertGates.js';

const NOW = new Date('2026-07-21T16:00:00Z');
const hoursAgo = (h: number): Date => new Date(NOW.getTime() - h * 3600 * 1000);

it('expires intraday moves after 24h but keeps filings for 72h', () => {
  assert.equal(isEventFresh(EventKind.IntradayMove, hoursAgo(23), NOW), true);
  assert.equal(isEventFresh(EventKind.IntradayMove, hoursAgo(25), NOW), false);
  assert.equal(isEventFresh(EventKind.Filing8K, hoursAgo(71), NOW), true);
  assert.equal(isEventFresh(EventKind.Filing8K, hoursAgo(73), NOW), false);
});

it('applies the 7-day ceiling to kinds without an explicit window', () => {
  assert.equal(EVENT_FRESHNESS_HOURS[EventKind.InsiderCluster], undefined);
  assert.equal(isEventFresh(EventKind.InsiderCluster, hoursAgo(6 * 24), NOW), true);
  assert.equal(isEventFresh(EventKind.InsiderCluster, hoursAgo(8 * 24), NOW), false);
});

it('never exceeds the legacy 7-day window for any kind', () => {
  for (const kind of Object.values(EventKind)) {
    const cutoff = freshnessCutoff(kind, NOW);
    assert.ok(
      cutoff.getTime() >= NOW.getTime() - MAX_EVENT_AGE_HOURS * 3600 * 1000,
      `${kind} window wider than the 7d ceiling`,
    );
  }
});

it('reads the daily cap from env with a sane fallback', () => {
  assert.equal(alertDailyLlmCap({}), DEFAULT_ALERT_DAILY_LLM_CAP);
  assert.equal(alertDailyLlmCap({ ALERT_DAILY_LLM_CAP: '15' }), 15);
  assert.equal(alertDailyLlmCap({ ALERT_DAILY_LLM_CAP: '0' }), DEFAULT_ALERT_DAILY_LLM_CAP);
  assert.equal(alertDailyLlmCap({ ALERT_DAILY_LLM_CAP: 'many' }), DEFAULT_ALERT_DAILY_LLM_CAP);
  assert.equal(alertDailyLlmCap({ ALERT_DAILY_LLM_CAP: '-3' }), DEFAULT_ALERT_DAILY_LLM_CAP);
});
