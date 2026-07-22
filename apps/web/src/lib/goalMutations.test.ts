/**
 * Goal-mutation core unit tests — focused on (1) input validation and (2) the
 * confirm-before-write gate + before→after diff. These are the load-bearing
 * guardrails for the chat-initiated mutations, so they are tested as pure
 * functions (no DB) the way the rest of the repo tests money/decision logic.
 *
 * Runs on node:test (stdlib) via tsx — same node:test pattern as
 * packages/core/src/goals/*.test.ts. Run with:
 *   pnpm --filter @vantage/web exec node --import tsx --test src/lib/goalMutations.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateGoalUpdate,
  gateConfirm,
  normalizeGoalCreate,
  normalizeContribution,
  parseGoalCalendarDate,
  summarizeDiff,
  normalizeTicker,
  type CurrentGoalState,
} from './goalMutations.ts';
import { torontoDateKey } from './marketTime.ts';

const CURRENT: CurrentGoalState = {
  name: 'House Down Payment',
  type: 'DownPayment',
  targetAmountCad: 100000,
  targetDate: new Date('2030-01-01T00:00:00Z'),
  isWithdrawal: false,
  notes: null,
  riskOverride: null,
  strategy: null,
  tradingStyle: null,
  contributionAmountCad: null,
  contributionFrequency: null,
  contributionStartDate: null,
  accountId: null,
};

describe('normalizeTicker', () => {
  it('uppercases + trims valid tickers', () => {
    const r = normalizeTicker('  acel ');
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.ticker, 'ACEL');
  });
  it('accepts dotted Canadian tickers', () => {
    const r = normalizeTicker('vdy.to');
    assert.equal(r.ok && r.ticker, 'VDY.TO');
  });
  it('rejects garbage', () => {
    assert.equal(normalizeTicker('').ok, false);
    assert.equal(normalizeTicker('not a ticker!').ok, false);
    assert.equal(normalizeTicker('TOOLONGTICKER').ok, false);
  });
});

describe('normalizeContribution', () => {
  it('requires frequency when an amount is set', () => {
    const r = normalizeContribution({
      type: 'DownPayment',
      contributionAmountCad: 500,
      contributionFrequency: null,
      contributionStartDate: null,
    });
    assert.equal(r.ok, false);
  });
  it('rejects negative amounts', () => {
    const r = normalizeContribution({
      type: 'DownPayment',
      contributionAmountCad: -10,
      contributionFrequency: 'Monthly',
      contributionStartDate: null,
    });
    assert.equal(r.ok, false);
  });
  it('strips any schedule for DayTrading goals', () => {
    const r = normalizeContribution({
      type: 'DayTrading',
      contributionAmountCad: 500,
      contributionFrequency: 'Monthly',
      contributionStartDate: null,
    });
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.value.amount, null);
    assert.equal(r.ok && r.value.frequency, null);
  });
  it('accepts a valid amount+frequency pair', () => {
    const r = normalizeContribution({
      type: 'DownPayment',
      contributionAmountCad: 250,
      contributionFrequency: 'Biweekly',
      contributionStartDate: '2026-07-01',
    });
    assert.equal(r.ok, true);
    assert.equal(r.ok && Number(r.value.amount), 250);
    assert.equal(r.ok && r.value.frequency, 'Biweekly');
    assert.equal(r.ok && r.value.startDate?.toISOString(), '2026-07-01T00:00:00.000Z');
  });
});

describe('goal calendar dates', () => {
  it('preserves date-only input at midnight UTC and rejects rollover dates', () => {
    assert.equal(parseGoalCalendarDate('2030-07-01')?.toISOString(), '2030-07-01T00:00:00.000Z');
    assert.equal(parseGoalCalendarDate('2030-02-31'), null);
  });

  it('accepts today in Toronto instead of treating UTC midnight as yesterday', () => {
    const r = normalizeGoalCreate({
      name: 'Today',
      type: 'Custom',
      targetAmountCad: 1000,
      targetDate: torontoDateKey(new Date()),
      isWithdrawal: false,
    });
    assert.equal(r.ok, true);
  });
});

describe('normalizeGoalCreate', () => {
  it('rejects a target date in the past', () => {
    const past = new Date();
    past.setDate(past.getDate() - 7);
    const r = normalizeGoalCreate({
      name: 'X',
      type: 'Custom',
      targetAmountCad: 1000,
      targetDate: past,
      isWithdrawal: false,
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.error, 'Target date cannot be in the past.');
  });
  it('rejects empty name', () => {
    const r = normalizeGoalCreate({
      name: '   ',
      type: 'Custom',
      targetAmountCad: 1000,
      targetDate: null,
      isWithdrawal: false,
    });
    assert.equal(r.ok, false);
  });
  it('rejects non-positive target', () => {
    const r = normalizeGoalCreate({
      name: 'X',
      type: 'Custom',
      targetAmountCad: 0,
      targetDate: null,
      isWithdrawal: false,
    });
    assert.equal(r.ok, false);
  });
  it('rejects an invalid goal type', () => {
    const r = normalizeGoalCreate({
      name: 'X',
      // deliberately bad value coming off an untrusted tool input
      type: 'Nonsense' as unknown as CurrentGoalState['type'],
      targetAmountCad: 1000,
      targetDate: null,
      isWithdrawal: false,
    });
    assert.equal(r.ok, false);
  });
  it('clears tradingStyle for non-DayTrading goals', () => {
    const r = normalizeGoalCreate({
      name: 'Growth',
      type: 'Retirement',
      targetAmountCad: 50000,
      targetDate: null,
      isWithdrawal: false,
      tradingStyle: 'Momentum',
    });
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.data.tradingStyle, null);
  });
  it('keeps tradingStyle for DayTrading goals', () => {
    const r = normalizeGoalCreate({
      name: 'Day book',
      type: 'DayTrading',
      targetAmountCad: 50000,
      targetDate: null,
      isWithdrawal: false,
      tradingStyle: 'ORB',
    });
    assert.equal(r.ok && r.data.tradingStyle, 'ORB');
  });
});

describe('validateGoalUpdate — diff', () => {
  it('produces a field-level diff for changed fields only', () => {
    const r = validateGoalUpdate(CURRENT, { targetAmountCad: 120000, name: 'House Down Payment' });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    // name is unchanged → excluded; targetAmountCad changed → present
    assert.equal(r.diff.length, 1);
    assert.equal(r.diff[0]?.field, 'targetAmountCad');
    assert.equal(r.diff[0]?.from, '100000');
    assert.equal(r.diff[0]?.to, '120000');
  });
  it('rejects an empty name', () => {
    const r = validateGoalUpdate(CURRENT, { name: '  ' });
    assert.equal(r.ok, false);
  });
  it('rejects a non-positive target', () => {
    const r = validateGoalUpdate(CURRENT, { targetAmountCad: -5 });
    assert.equal(r.ok, false);
  });
  it('clears the contribution schedule when switching to DayTrading', () => {
    const withSchedule: CurrentGoalState = {
      ...CURRENT,
      contributionAmountCad: 500,
      contributionFrequency: 'Monthly',
    };
    const r = validateGoalUpdate(withSchedule, { type: 'DayTrading' });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.data.contributionAmountCad, null);
    assert.equal(r.data.contributionFrequency, null);
  });

  it('rejects target date updates that are in the past', () => {
    const r = validateGoalUpdate(CURRENT, {
      targetDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.error, 'Target date cannot be in the past.');
  });

  it('diffs account changes with previous account reflected', () => {
    const withAccount: CurrentGoalState = {
      ...CURRENT,
      accountId: 4,
    };
    const r = validateGoalUpdate(withAccount, { accountId: 9 });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const accountField = r.diff.find((d) => d.field === 'accountId');
    assert.ok(accountField);
    assert.equal(accountField?.from, '4');
    assert.equal(accountField?.to, '9');
  });
});

// The actual guardrail: gateConfirm must NEVER signal "proceed" without an
// explicit confirm===true, and a preview must carry the diff + summary.
describe('gateConfirm — confirm-before-write gate', () => {
  const diff = [{ field: 'targetAmountCad', from: '100000', to: '120000' }];
  const summary = summarizeDiff('House Down Payment', diff);

  it('does NOT proceed when confirm is undefined (returns a preview)', () => {
    const g = gateConfirm(undefined, diff, summary);
    assert.equal(g.proceed, false);
    if (g.proceed) return;
    assert.equal(g.preview.status, 'preview');
    assert.deepEqual(g.preview.diff, diff);
    assert.match(g.preview.summary, /120000/);
  });
  it('does NOT proceed when confirm is false', () => {
    assert.equal(gateConfirm(false, diff, summary).proceed, false);
  });
  it('does NOT proceed for truthy-but-not-true values', () => {
    // Guards against a stringly-typed "true" or 1 sneaking past the gate.
    assert.equal(gateConfirm('true' as unknown as boolean, diff, summary).proceed, false);
    assert.equal(gateConfirm(1 as unknown as boolean, diff, summary).proceed, false);
  });
  it('proceeds ONLY when confirm === true', () => {
    assert.equal(gateConfirm(true, diff, summary).proceed, true);
  });
});

describe('summarizeDiff', () => {
  it('renders a human one-liner', () => {
    const s = summarizeDiff('Vacation', [{ field: 'targetAmountCad', from: '5000', to: '8000' }]);
    assert.match(s, /Vacation/);
    assert.match(s, /5000 → 8000/);
  });
  it('reports no-op diffs', () => {
    assert.match(summarizeDiff('X', []), /No changes/);
  });
});
