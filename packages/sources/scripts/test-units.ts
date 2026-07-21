/**
 * Minimal unit tests for rate-limit / classify / dedup.
 * Plain tsx script — full test harness comes in Phase 14.
 *
 * Run: pnpm tsx packages/sources/scripts/test-units.ts
 */

import { strict as assert } from 'node:assert';
import { RateLimiter } from '../src/rate-limit.js';
import { classifyDomain, isSatireDomain } from '../src/classify.js';
import { clusterKey, normalize, roundTime } from '../src/dedup.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL  ${name}`);
    console.error(`    ${e instanceof Error ? e.message : String(e)}`);
    failed++;
  }
}

console.log('\n--- rate-limit ---');

await test('acquire resolves immediately when tokens available', async () => {
  const rl = new RateLimiter({ perMinute: 60 });
  const t0 = Date.now();
  await rl.acquire();
  assert.ok(Date.now() - t0 < 20, 'should not block on first acquire');
});

await test('capacity respected: 60/min allows 60 bursts without blocking', async () => {
  const rl = new RateLimiter({ perMinute: 60 });
  const t0 = Date.now();
  for (let i = 0; i < 60; i++) {
    await rl.acquire();
  }
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 100, `burst of 60 took ${elapsed}ms (should be <100ms)`);
});

await test('61st acquire blocks (approx) until refill', async () => {
  // 600/min => 10/sec => refill 1 token per 100ms
  const rl = new RateLimiter({ perMinute: 600 });
  // drain the bucket
  for (let i = 0; i < 600; i++) await rl.acquire();
  const t0 = Date.now();
  await rl.acquire();
  const waited = Date.now() - t0;
  // should wait ~100ms (1 token refill). Allow 60-250ms for CI jitter.
  assert.ok(waited >= 60 && waited < 250, `expected ~100ms wait, got ${waited}ms`);
});

await test('FIFO ordering: waiters served in order', async () => {
  const rl = new RateLimiter({ perMinute: 60 });
  for (let i = 0; i < 60; i++) await rl.acquire();
  const order: number[] = [];
  const p1 = rl.acquire().then(() => order.push(1));
  const p2 = rl.acquire().then(() => order.push(2));
  const p3 = rl.acquire().then(() => order.push(3));
  await Promise.all([p1, p2, p3]);
  assert.deepEqual(order, [1, 2, 3], 'waiters should resolve FIFO');
});

await test('perDay constraint applies', async () => {
  // Use an injectable clock so we can verify day-bucket accounting deterministically.
  const now = 0;
  const rl = new RateLimiter({ perMinute: 120, perDay: 2, now: () => now });
  await rl.acquire();
  await rl.acquire();
  // Day bucket is now empty; next acquire would queue. Verify via snapshot.
  const snap = rl.snapshot();
  assert.ok(snap.dayTokens !== null && snap.dayTokens < 1, 'day bucket should be near zero');
});

console.log('\n--- classify ---');

await test('tier 1: reuters.com', () => {
  const r = classifyDomain('https://www.reuters.com/markets/us/foo');
  assert.equal(r.tier, 1);
  assert.equal(r.domain, 'reuters.com');
  assert.equal(r.isSatire, false);
});

await test('tier 1: SEC', () => {
  const r = classifyDomain('https://www.sec.gov/Archives/edgar/data/320193/foo-8k.htm');
  assert.equal(r.tier, 1);
});

await test('tier 2: cnbc.com', () => {
  const r = classifyDomain('https://www.cnbc.com/2026/04/19/aapl-foo.html');
  assert.equal(r.tier, 2);
});

await test('tier 2: finance.yahoo.com (subdomain of yahoo.com)', () => {
  const r = classifyDomain('https://finance.yahoo.com/news/aapl');
  assert.equal(r.tier, 2);
});

await test('tier 3: reddit.com', () => {
  const r = classifyDomain('https://www.reddit.com/r/wallstreetbets/comments/abc');
  assert.equal(r.tier, 3);
});

await test('tier 3: unknown domain defaults to 3', () => {
  const r = classifyDomain('https://some-random-blog.xyz/post');
  assert.equal(r.tier, 3);
});

await test('satire: babylonbee.com detected', () => {
  assert.equal(isSatireDomain('https://babylonbee.com/news/area-man-invests-savings-in-nft'), true);
});

await test('satire: theonion.com detected', () => {
  const r = classifyDomain('https://www.theonion.com/fed-raises-rates-again-to-punish-everyone');
  assert.equal(r.isSatire, true);
});

await test('invalid URL returns tier 3 and null domain', () => {
  const r = classifyDomain('not a url');
  assert.equal(r.tier, 3);
  assert.equal(r.domain, null);
});

console.log('\n--- dedup ---');

await test('normalize lowercases + strips punctuation + collapses whitespace', () => {
  assert.equal(normalize('  Apple, Inc.  beats   EPS!  '), 'apple inc beats eps');
});

await test('roundTime floors to the 6h UTC boundary', () => {
  const d = new Date('2026-04-19T14:37:12.000Z');
  assert.equal(roundTime(d, 6), '2026-04-19T12:00:00.000Z');
  const d2 = new Date('2026-04-19T05:59:59.000Z');
  assert.equal(roundTime(d2, 6), '2026-04-19T00:00:00.000Z');
});

await test('same headline + ticker within 6h window => same cluster', () => {
  const t1 = new Date('2026-04-19T12:10:00Z');
  const t2 = new Date('2026-04-19T17:55:00Z'); // same 12:00-18:00 bucket
  const k1 = clusterKey('Apple beats Q2 earnings expectations on iPhone strength', t1, 'AAPL');
  const k2 = clusterKey('apple beats q2 earnings expectations on iphone strength!!', t2, 'AAPL');
  assert.equal(k1, k2, 'should cluster identical stories in same 6h window');
});

await test('different ticker => different cluster', () => {
  const t = new Date('2026-04-19T12:10:00Z');
  const k1 = clusterKey('Headline X', t, 'AAPL');
  const k2 = clusterKey('Headline X', t, 'MSFT');
  assert.notEqual(k1, k2);
});

await test('different 6h bucket => different cluster', () => {
  const t1 = new Date('2026-04-19T11:59:00Z'); // 06:00 bucket
  const t2 = new Date('2026-04-19T12:01:00Z'); // 12:00 bucket
  const k1 = clusterKey('Headline X', t1, 'AAPL');
  const k2 = clusterKey('Headline X', t2, 'AAPL');
  assert.notEqual(k1, k2);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
