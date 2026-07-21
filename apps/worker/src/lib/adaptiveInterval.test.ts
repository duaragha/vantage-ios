import assert from 'node:assert/strict';
import { it } from 'node:test';
import { AdaptiveInterval } from './adaptiveInterval.js';

it('doubles while idle and caps at the maximum', () => {
  const interval = new AdaptiveInterval(10_000, 300_000);
  assert.equal(interval.currentMs, 10_000);
  assert.equal(interval.observe(false), 20_000);
  assert.equal(interval.observe(false), 40_000);
  assert.equal(interval.observe(false), 80_000);
  assert.equal(interval.observe(false), 160_000);
  assert.equal(interval.observe(false), 300_000);
  assert.equal(interval.observe(false), 300_000);
});

it('snaps back to base when work shows up', () => {
  const interval = new AdaptiveInterval(10_000, 300_000);
  interval.observe(false);
  interval.observe(false);
  assert.equal(interval.observe(true), 10_000);
  interval.observe(false);
  interval.reset();
  assert.equal(interval.currentMs, 10_000);
});

it('rejects nonsense bounds', () => {
  assert.throws(() => new AdaptiveInterval(0, 1000));
  assert.throws(() => new AdaptiveInterval(2000, 1000));
});
