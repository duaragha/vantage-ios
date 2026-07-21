/**
 * Placement engine unit tests.
 *
 * Runs on node:test (stdlib) — same pattern as discover/verdict.test.ts.
 *
 * Run with:
 *   pnpm --filter @vantage/core build && \
 *   node --test packages/core/dist/accounts/placement.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decidePlacement,
  type AccountSummary,
  type StockProfile,
} from './placement.js';

function stock(overrides: Partial<StockProfile> = {}): StockProfile {
  return {
    ticker: 'TEST',
    listingCountry: 'US',
    dividendYieldTtm: null,
    growth5y: null,
    beta: null,
    isSpeculative: false,
    marketCapUsd: null,
    ...overrides,
  };
}

function account(overrides: Partial<AccountSummary> & { id: number; type: AccountSummary['type'] }): AccountSummary {
  return {
    currency: 'CAD',
    contributionRoomCad: null,
    currentValueCad: 0,
    archived: false,
    ...overrides,
  };
}

describe('decidePlacement — speculative branch', () => {
  it('routes a speculative stock to Personal/Margin only', () => {
    const s = stock({ isSpeculative: true, listingCountry: 'US', dividendYieldTtm: 0.05, growth5y: 0.3 });
    const accounts: AccountSummary[] = [
      account({ id: 1, type: 'TFSA', contributionRoomCad: 50_000 }),
      account({ id: 2, type: 'Personal' }),
    ];
    const d = decidePlacement(s, accounts);
    assert.deepEqual(d.rankedAccountTypes, ['Personal', 'Margin']);
    assert.equal(d.bestAccountId, 2);
    assert.match(d.rationale, /Speculative/i);
  });

  it('returns null bestAccountId when only TFSA exists for a speculative stock', () => {
    const s = stock({ isSpeculative: true });
    const accounts: AccountSummary[] = [account({ id: 1, type: 'TFSA', contributionRoomCad: 10_000 })];
    const d = decidePlacement(s, accounts);
    assert.equal(d.bestAccountId, null);
  });
});

describe('decidePlacement — US dividend branch', () => {
  it('prefers RRSP over TFSA for a US dividend payer', () => {
    const s = stock({ listingCountry: 'US', dividendYieldTtm: 0.025 });
    const accounts: AccountSummary[] = [
      account({ id: 1, type: 'TFSA', contributionRoomCad: 50_000 }),
      account({ id: 2, type: 'RRSP', contributionRoomCad: 20_000 }),
      account({ id: 3, type: 'Personal' }),
    ];
    const d = decidePlacement(s, accounts);
    assert.equal(d.rankedAccountTypes[0], 'RRSP');
    assert.equal(d.bestAccountId, 2);
  });

  it('computes ~37 bps drag for a 2.5% yield × 15% withholding', () => {
    const s = stock({ listingCountry: 'US', dividendYieldTtm: 0.025 });
    const d = decidePlacement(s, []);
    const tfsaDrag = d.tradeoffsBps?.find((t) => t.accountType === 'TFSA');
    assert.ok(tfsaDrag, 'TFSA tradeoff present');
    // 0.025 * 0.15 * 10_000 = 37.5, rounded to 38
    assert.ok(Math.abs(tfsaDrag.dragBps - 37.5) <= 1, `expected ~37.5 bps, got ${tfsaDrag.dragBps}`);
  });

  it('falls back to next-best when user only has TFSA + Personal', () => {
    const s = stock({ listingCountry: 'US', dividendYieldTtm: 0.03 });
    const accounts: AccountSummary[] = [
      account({ id: 1, type: 'TFSA', contributionRoomCad: 50_000 }),
      account({ id: 2, type: 'Personal' }),
    ];
    const d = decidePlacement(s, accounts);
    assert.equal(d.bestAccountId, 2);
  });

  it('prefers USD sub-account when both CAD and USD personal accounts exist for a US stock', () => {
    const s = stock({ listingCountry: 'US', dividendYieldTtm: 0.03 });
    const accounts: AccountSummary[] = [
      account({ id: 10, type: 'Personal', currency: 'CAD' }),
      account({ id: 11, type: 'Personal', currency: 'USD' }),
    ];
    const d = decidePlacement(s, accounts);
    assert.equal(d.bestAccountId, 11);
  });
});

describe('decidePlacement — Canadian dividend branch', () => {
  it('prefers TFSA and deranks RRSP for a Canadian dividend stock', () => {
    const s = stock({ listingCountry: 'CA', dividendYieldTtm: 0.04 });
    const accounts: AccountSummary[] = [
      account({ id: 1, type: 'TFSA', contributionRoomCad: 30_000 }),
      account({ id: 2, type: 'RRSP', contributionRoomCad: 50_000 }),
      account({ id: 3, type: 'Personal' }),
    ];
    const d = decidePlacement(s, accounts);
    assert.equal(d.rankedAccountTypes[0], 'TFSA');
    const tfsaIdx = d.rankedAccountTypes.indexOf('TFSA');
    const rrspIdx = d.rankedAccountTypes.indexOf('RRSP');
    assert.ok(tfsaIdx < rrspIdx, 'TFSA must rank above RRSP for CA dividend');
    assert.equal(d.bestAccountId, 1);
  });
});

describe('decidePlacement — high-growth branch', () => {
  it('prefers TFSA over RRSP for high-growth no-dividend stock', () => {
    const s = stock({ listingCountry: 'US', dividendYieldTtm: 0, growth5y: 0.3 });
    const accounts: AccountSummary[] = [
      account({ id: 1, type: 'RRSP', contributionRoomCad: 50_000 }),
      account({ id: 2, type: 'TFSA', contributionRoomCad: 20_000 }),
    ];
    const d = decidePlacement(s, accounts);
    assert.equal(d.rankedAccountTypes[0], 'TFSA');
    assert.equal(d.bestAccountId, 2);
  });

  it('skips growth branch when dividend yield is meaningful', () => {
    const s = stock({ listingCountry: 'CA', dividendYieldTtm: 0.02, growth5y: 0.25 });
    const d = decidePlacement(s, []);
    // CA dividend branch wins because yield > threshold
    assert.equal(d.rankedAccountTypes[0], 'TFSA');
    assert.match(d.rationale, /dividend tax credit/i);
  });
});

describe('decidePlacement — default branch', () => {
  it('falls through to default rank when growth and yield are both null', () => {
    const s = stock({ listingCountry: 'US', dividendYieldTtm: null, growth5y: null });
    const d = decidePlacement(s, []);
    assert.equal(d.rankedAccountTypes[0], 'TFSA');
  });
});

describe('decidePlacement — account resolution', () => {
  it('returns null bestAccountId when accounts is empty', () => {
    const s = stock({ listingCountry: 'US', dividendYieldTtm: 0.025 });
    const d = decidePlacement(s, []);
    assert.equal(d.bestAccountId, null);
    assert.match(d.rationale, /No accounts on file/);
  });

  it('returns null when all accounts are archived', () => {
    const s = stock({ growth5y: 0.3 });
    const accounts: AccountSummary[] = [
      account({ id: 1, type: 'TFSA', contributionRoomCad: 50_000, archived: true }),
      account({ id: 2, type: 'RRSP', contributionRoomCad: 20_000, archived: true }),
    ];
    const d = decidePlacement(s, accounts);
    assert.equal(d.bestAccountId, null);
  });

  it('prefers account with most room remaining when multiple of same type exist', () => {
    const s = stock({ growth5y: 0.3 });
    const accounts: AccountSummary[] = [
      account({ id: 1, type: 'TFSA', contributionRoomCad: 5_000 }),
      account({ id: 2, type: 'TFSA', contributionRoomCad: 30_000 }),
    ];
    const d = decidePlacement(s, accounts);
    assert.equal(d.bestAccountId, 2);
  });

  it('skips full accounts (room === 0) when an alternative exists', () => {
    const s = stock({ growth5y: 0.3 });
    const accounts: AccountSummary[] = [
      account({ id: 1, type: 'TFSA', contributionRoomCad: 0 }),
      account({ id: 2, type: 'Personal' }),
    ];
    const d = decidePlacement(s, accounts);
    assert.equal(d.bestAccountId, 2);
  });
});
