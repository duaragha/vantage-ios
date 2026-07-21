import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateCost, WEB_SEARCH_COST_USD } from './cost.js';

test('calculateCost includes the Anthropic web-search surcharge', () => {
  const cost = calculateCost({
    model: 'claude-sonnet-4-6',
    inputTokens: 0,
    outputTokens: 0,
    webSearchRequests: 3,
  });

  assert.equal(cost, 3 * WEB_SEARCH_COST_USD);
});

test('web-fetch-only usage has no request surcharge', () => {
  const cost = calculateCost({
    model: 'claude-sonnet-4-6',
    inputTokens: 0,
    outputTokens: 0,
  });

  assert.equal(cost, 0);
});

test('calculateCost combines token, cache and web-search costs', () => {
  const cost = calculateCost({
    model: 'claude-haiku-4-5',
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cachedTokens: 1_000_000,
    cacheCreationTokens: 1_000_000,
    webSearchRequests: 2,
  });

  assert.ok(Math.abs(cost - 7.37) < 1e-9, `expected 7.37 got ${cost}`);
});
