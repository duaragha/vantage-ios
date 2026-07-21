import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatRetrievedBlock, type ChatRetrievalBundle } from './chatRetrieval.js';

function emptyBundle(overrides: Partial<ChatRetrievalBundle> = {}): ChatRetrievalBundle {
  return {
    tickersUsed: [],
    articleHits: [],
    thesisHits: [],
    discoveryScores: [],
    metrics: [],
    fundamentals: [],
    events: [],
    priceSummaries: [],
    accounts: [],
    goals: [],
    watchlist: [],
    insights: [],
    systemHealth: {
      spendTodayUsd: 0,
      spendMonthUsd: 0,
      dailyCapUsd: 2,
      monthlyCapUsd: 40,
      killSwitch: false,
      jobs: [],
    },
    settings: null,
    recentMessages: [],
    unavailableSections: [],
    retrievalWarnings: [],
    ...overrides,
  };
}

describe('chat retrieval honesty', () => {
  it('distinguishes an unavailable account query from a confirmed empty result', () => {
    const unavailable = formatRetrievedBlock(emptyBundle({ unavailableSections: ['accounts'] }));
    assert.match(unavailable, /account rows are unavailable/i);
    assert.doesNotMatch(unavailable, /don't have any accounts on file/i);

    const confirmedEmpty = formatRetrievedBlock(emptyBundle());
    assert.match(confirmedEmpty, /don't have any accounts on file/i);
  });

  it('labels unavailable operational values instead of substituting zero or off', () => {
    const block = formatRetrievedBlock(
      emptyBundle({
        unavailableSections: ['spend', 'settings', 'jobs'],
        retrievalWarnings: ['Account values are approximate.'],
        systemHealth: {
          spendTodayUsd: null,
          spendMonthUsd: null,
          dailyCapUsd: null,
          monthlyCapUsd: null,
          killSwitch: null,
          jobs: [],
        },
      }),
    );

    assert.match(block, /Today's spend: unavailable of unavailable daily cap/);
    assert.match(block, /Kill switch: unavailable/);
    assert.match(block, /settings are unavailable/i);
    assert.match(block, /Account values are approximate/);
  });
});
