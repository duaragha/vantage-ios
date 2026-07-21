/**
 * sentimentScore unit tests — native StockTwits bull/bear tags with keyword fallback.
 *
 * Runs on node:test (stdlib), compiled as part of the core tsc build.
 * Run with:
 *   pnpm --filter @vantage/core build && \
 *   node --test packages/core/dist/discover/signals.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Article } from '@vantage/db';
import {
  discoveryScoreDeltaForRotation,
  discoveryScoreToRotationSignal,
  sentimentScore,
} from './signals.js';

function art(overrides: Partial<Article> = {}): Article {
  return {
    id: 1,
    sourceTier: 3,
    source: 'stocktwits',
    domain: 'stocktwits.com',
    url: 'https://stocktwits.com/message/1',
    headline: '',
    body: null,
    publishedAt: new Date(),
    tickers: ['AAPL'],
    clusterId: null,
    trustedCitable: true,
    satireBlocked: false,
    socialSentiment: null,
    fetchedAt: new Date(),
    ...overrides,
  } as unknown as Article;
}

describe('sentimentScore', () => {
  it('returns 0 for no articles', () => {
    assert.equal(sentimentScore([]), 0);
  });

  it('is positive when native tags are net bullish', () => {
    const arts = [
      ...Array.from({ length: 8 }, () => art({ socialSentiment: 'Bullish' })),
      ...Array.from({ length: 2 }, () => art({ socialSentiment: 'Bearish' })),
    ];
    assert.ok(sentimentScore(arts) > 0, 'net-bullish native tags should score positive');
  });

  it('is negative when native tags are net bearish', () => {
    const arts = [
      ...Array.from({ length: 2 }, () => art({ socialSentiment: 'Bullish' })),
      ...Array.from({ length: 8 }, () => art({ socialSentiment: 'Bearish' })),
    ];
    assert.ok(sentimentScore(arts) < 0, 'net-bearish native tags should score negative');
  });

  it('falls back to keyword scan for untagged posts', () => {
    const arts = [
      art({ socialSentiment: null, headline: 'huge surge, rally, breakout — bullish' }),
      art({ socialSentiment: null, body: 'beats and soars' }),
    ];
    assert.ok(sentimentScore(arts) > 0, 'untagged positive-keyword posts score positive');
  });

  it('native tag takes precedence over conflicting keywords', () => {
    // Text is loaded with bullish keywords, but the user tagged it Bearish.
    // The tag must win — keywords are only consulted when there is no tag.
    const arts = Array.from({ length: 5 }, () =>
      art({ socialSentiment: 'Bearish', headline: 'surge rally moon breakout bullish rocket' }),
    );
    assert.ok(sentimentScore(arts) < 0, 'native Bearish tag overrides bullish keywords');
  });

  it('stays clamped within [-0.5, 0.5]', () => {
    const arts = Array.from({ length: 500 }, () => art({ socialSentiment: 'Bullish' }));
    const s = sentimentScore(arts);
    assert.ok(s <= 0.5 && s >= -0.5, 'bounded to [-0.5, 0.5]');
  });
});

describe('discovery score rotation normalization', () => {
  it('maps the 0-10 display score onto the intended 0-1 gate scale', () => {
    assert.equal(discoveryScoreToRotationSignal(6), 0.6);
    assert.equal(discoveryScoreToRotationSignal(3), 0.3);
    assert.equal(discoveryScoreToRotationSignal(12), 1);
    assert.equal(discoveryScoreToRotationSignal(-12), -1);
  });

  it('normalizes raw score differences before applying swap thresholds', () => {
    assert.equal(discoveryScoreDeltaForRotation(7, 4), 0.3);
    assert.equal(discoveryScoreDeltaForRotation(8, 2), 0.6);
    assert.equal(discoveryScoreDeltaForRotation(Number.NaN, 2), 0);
  });
});
