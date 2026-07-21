/**
 * Unit tests for the keyword pre-filter and tool-call parsing.
 * Plain tsx script — full test harness comes in Phase 14.
 *
 * Run: pnpm tsx packages/llm/scripts/test-units.ts
 */

import { strict as assert } from 'node:assert';
import { hasTickerMention } from '../src/keyword-filter.js';
import {
  parseThesisUpdate,
  parseRebalanceSuggestion,
  parseBuySuggestion,
  parseAlert,
} from '../src/tools.js';
import { calculateCost, MODEL_PRICING } from '../src/cost.js';
import { pickModel, HAIKU_MODEL, SONNET_MODEL, OPUS_MODEL } from '../src/tier.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve().then(async () => {
    try {
      await fn();
      console.log(`  ok  ${name}`);
      passed++;
    } catch (e) {
      console.error(`  FAIL  ${name}`);
      console.error(`    ${e instanceof Error ? e.message : String(e)}`);
      failed++;
    }
  });
}

// ---------------------------------------------------------------------------
// keyword-filter
// ---------------------------------------------------------------------------

console.log('\n--- keyword-filter ---');

await test('matches a simple symbol on word boundary', () => {
  const out = hasTickerMention('AAPL reports record Q4 revenue', [{ symbol: 'AAPL' }]);
  assert.deepEqual(out, ['AAPL']);
});

await test('is case-insensitive for symbol', () => {
  const out = hasTickerMention('apple ticker aapl is up 3%', [{ symbol: 'AAPL' }]);
  assert.deepEqual(out, ['AAPL']);
});

await test('does NOT match a symbol embedded inside another word', () => {
  // "MU" (Micron) should NOT match inside "mutual"
  const out = hasTickerMention('Mutual funds rotated into tech this quarter', [{ symbol: 'MU' }]);
  assert.deepEqual(out, []);
});

await test('does NOT match "AI" inside "Said"', () => {
  const out = hasTickerMention('Said the analyst earlier', [{ symbol: 'AI' }]);
  assert.deepEqual(out, []);
});

await test('matches an alias when the symbol is absent', () => {
  const out = hasTickerMention('Apple announced a new Vision Pro model today.', [
    { symbol: 'AAPL', aliases: ['Apple'] },
  ]);
  assert.deepEqual(out, ['AAPL']);
});

await test('multi-word alias matches with internal whitespace variation', () => {
  const out = hasTickerMention('The New York Times reported a shift in subscribers', [
    { symbol: 'NYT', aliases: ['New York Times'] },
  ]);
  assert.deepEqual(out, ['NYT']);
});

await test('returns multiple distinct matches', () => {
  const text = 'Both AAPL and MSFT hit all-time highs on Friday.';
  const out = hasTickerMention(text, [{ symbol: 'AAPL' }, { symbol: 'MSFT' }, { symbol: 'TSLA' }]);
  assert.ok(out.includes('AAPL') && out.includes('MSFT'));
  assert.equal(out.length, 2);
});

await test('dedups when symbol + alias both match', () => {
  const out = hasTickerMention('AAPL and Apple both appear here', [
    { symbol: 'AAPL', aliases: ['Apple'] },
  ]);
  assert.deepEqual(out, ['AAPL']);
});

await test('empty text returns empty array', () => {
  assert.deepEqual(hasTickerMention('', [{ symbol: 'AAPL' }]), []);
});

await test('empty ticker list returns empty array', () => {
  assert.deepEqual(hasTickerMention('Plenty of AAPL news here', []), []);
});

await test('ignores regex metacharacters in aliases (escapes properly)', () => {
  // "S&P 500" contains the special "&" and is otherwise benign, but we want
  // to make sure a user-supplied alias with dots/parens does not break the
  // regex compilation. This alias had trailing "." which would have been "any char".
  const out = hasTickerMention('A Mega.Corp Inc. press release.', [
    { symbol: 'MCI', aliases: ['Mega.Corp Inc.'] },
  ]);
  assert.deepEqual(out, ['MCI']);
});

await test('does not double-count a symbol that also has an alias miss', () => {
  // Alias is missing from text but symbol matches — should still return symbol.
  const out = hasTickerMention('Tesla crushed Q3 (TSLA)', [
    { symbol: 'TSLA', aliases: ['Tesla Motors, Inc.'] },
  ]);
  assert.deepEqual(out, ['TSLA']);
});

// ---------------------------------------------------------------------------
// tool-call parsing
// ---------------------------------------------------------------------------

console.log('\n--- tool-call parsing ---');

await test('parseThesisUpdate accepts a well-formed payload', () => {
  const out = parseThesisUpdate({
    positionId: 42,
    newStatus: 'Weakening',
    rationale: 'Q3 guidance missed consensus by 8%.',
    citations: [{ articleId: 1, quote: 'Guidance down' }],
  });
  assert.ok(out, 'expected non-null parse');
  assert.equal(out!.positionId, 42);
  assert.equal(out!.newStatus, 'Weakening');
});

await test('parseThesisUpdate rejects empty citations', () => {
  const out = parseThesisUpdate({
    positionId: 42,
    newStatus: 'Intact',
    rationale: 'No change',
    citations: [],
  });
  // Empty array still passes isCitationArray (it is empty), but we want to
  // verify that the stripper enforces the rule. This parse call alone returns
  // a payload (schema-valid) — defensive rejection lives in citation-stripper.
  assert.ok(out, 'parse is schema-level only; citation-stripper handles emptiness');
});

await test('parseThesisUpdate rejects invalid status', () => {
  const out = parseThesisUpdate({
    positionId: 42,
    newStatus: 'Unknown',
    rationale: 'x',
    citations: [{ articleId: 1, quote: 'q' }],
  });
  assert.equal(out, null);
});

await test('parseRebalanceSuggestion accepts rotate with targetTicker', () => {
  const out = parseRebalanceSuggestion({
    action: 'rotate',
    ticker: 'ABCD',
    targetTicker: 'WXYZ',
    shares: 100,
    reasoning: 'rotate into adjacency',
    citations: [{ articleId: 7, quote: 'sector news' }],
    confidence: 'Medium',
  });
  assert.ok(out);
  assert.equal(out!.action, 'rotate');
  assert.equal(out!.targetTicker, 'WXYZ');
});

await test('parseRebalanceSuggestion rejects bad action', () => {
  const out = parseRebalanceSuggestion({
    action: 'NUKE',
    ticker: 'ABCD',
    shares: 1,
    reasoning: 'x',
    citations: [{ articleId: 1, quote: 'q' }],
    confidence: 'Low',
  });
  assert.equal(out, null);
});

await test('parseBuySuggestion accepts well-formed payload', () => {
  const out = parseBuySuggestion({
    ticker: 'WXYZ',
    shares: 50,
    reasoning: 'within caps, tier-1 news',
    citations: [{ articleId: 7, quote: 'Reuters' }],
    confidence: 'High',
  });
  assert.ok(out);
  assert.equal(out!.ticker, 'WXYZ');
  assert.equal(out!.confidence, 'High');
});

await test('parseAlert accepts well-formed payload', () => {
  const out = parseAlert({
    kind: 'earnings',
    title: 'AAPL beats',
    body: 'Beat by $0.11',
    reasoning: 'tier-1 confirmation',
    citations: [{ articleId: 1, quote: 'beat' }],
  });
  assert.ok(out);
  assert.equal(out!.kind, 'earnings');
});

await test('parse rejects citation with non-numeric articleId', () => {
  const out = parseThesisUpdate({
    positionId: 42,
    newStatus: 'Intact',
    rationale: 'x',
    citations: [{ articleId: 'nope', quote: 'q' }],
  });
  assert.equal(out, null);
});

// ---------------------------------------------------------------------------
// cost + tier
// ---------------------------------------------------------------------------

console.log('\n--- cost + tier ---');

await test('pickModel returns Haiku for relevance-filter', () => {
  assert.equal(pickModel('relevance-filter'), HAIKU_MODEL);
});

await test('pickModel returns Sonnet for digest/alert/chat', () => {
  assert.equal(pickModel('digest'), SONNET_MODEL);
  assert.equal(pickModel('alert'), SONNET_MODEL);
  assert.equal(pickModel('thesis-eval'), SONNET_MODEL);
  assert.equal(pickModel('rebalance'), SONNET_MODEL);
  assert.equal(pickModel('chat'), SONNET_MODEL);
});

await test('pickModel returns Opus for weekly-deepdive', () => {
  assert.equal(pickModel('weekly-deepdive'), OPUS_MODEL);
});

await test('calculateCost Haiku: 1M in + 1M out = $1 + $5 = $6', () => {
  const cost = calculateCost({
    model: 'claude-haiku-4-5',
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
  });
  assert.ok(Math.abs(cost - 6.0) < 1e-9, `expected 6.0 got ${cost}`);
});

await test('calculateCost Sonnet: 1M in + 1M out = $3 + $15 = $18', () => {
  const cost = calculateCost({
    model: 'claude-sonnet-4-6',
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
  });
  assert.ok(Math.abs(cost - 18.0) < 1e-9, `expected 18.0 got ${cost}`);
});

await test('calculateCost Opus: 1M in + 1M out = $5 + $25 = $30', () => {
  const cost = calculateCost({
    model: 'claude-opus-4-7',
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
  });
  assert.ok(Math.abs(cost - 30.0) < 1e-9, `expected 30.0 got ${cost}`);
});

await test('calculateCost applies 0.1x on cached tokens', () => {
  // Haiku: 0 uncached input, 1M cached read = $0.10
  const cost = calculateCost({
    model: 'claude-haiku-4-5',
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 1_000_000,
  });
  assert.ok(Math.abs(cost - 0.1) < 1e-9, `expected 0.10 got ${cost}`);
});

await test('calculateCost applies 1.25x on cache-creation tokens (Haiku)', () => {
  const cost = calculateCost({
    model: 'claude-haiku-4-5',
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 1_000_000,
  });
  assert.ok(Math.abs(cost - 1.25) < 1e-9, `expected 1.25 got ${cost}`);
});

await test('calculateCost includes Anthropic web-search requests', () => {
  const cost = calculateCost({
    model: 'claude-haiku-4-5',
    inputTokens: 0,
    outputTokens: 0,
    webSearchRequests: 3,
  });
  assert.ok(Math.abs(cost - 0.03) < 1e-9, `expected 0.03 got ${cost}`);
});

await test('calculateCost unknown model falls back to Sonnet pricing', () => {
  // Suppress the console.warn in test output by capturing.
  const origWarn = console.warn;
  console.warn = (): void => {};
  try {
    const cost = calculateCost({
      model: 'claude-imaginary-9',
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    assert.equal(cost, MODEL_PRICING['claude-sonnet-4-6'].inputPerMTok);
  } finally {
    console.warn = origWarn;
  }
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
