/**
 * Formatter unit tests — focused on fmtDollarVolume's $M → $X.XB rollover (the
 * day-trade scanner's $-VOL column). Pure function, no DOM.
 *
 * Same node:test + tsx pattern as goalMutations.test.ts. Run with:
 *   pnpm --filter @vantage/web exec node --import tsx --test src/lib/format.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fmtCalendarDate, fmtDollarVolume, fmtMoney, fmtMoneySigned } from './format.ts';

describe('currency formatters', () => {
  it('labels CAD amounts with C$ and preserves the sign', () => {
    assert.equal(fmtMoney(1234.5, 'CAD'), 'C$1,234.50');
    assert.equal(fmtMoneySigned(125.25, 'CAD'), '+C$125.25');
    assert.equal(fmtMoneySigned(-125.25, 'CAD'), '-C$125.25');
  });

  it('keeps USD on the standard dollar prefix', () => {
    assert.equal(fmtMoney(1234.5, 'USD'), '$1,234.50');
    assert.equal(fmtMoneySigned(125.25, 'USD'), '+$125.25');
  });
});

describe('calendar-date formatter', () => {
  it('does not shift a UTC-midnight database date into the prior local day', () => {
    assert.equal(fmtCalendarDate(new Date('2026-07-17T00:00:00.000Z')), 'Jul 17, 2026');
  });
});

describe('fmtDollarVolume', () => {
  it('keeps values below $1B as whole millions ($XXM)', () => {
    assert.equal(fmtDollarVolume(324_000_000), '$324M');
    assert.equal(fmtDollarVolume(565_000_000), '$565M');
    assert.equal(fmtDollarVolume(5_000_000), '$5M');
    // Just under the $1B boundary still reads in millions.
    assert.equal(fmtDollarVolume(999_000_000), '$999M');
  });

  it('rolls values at/above $1B up to $X.XB (one decimal)', () => {
    assert.equal(fmtDollarVolume(17_490_000_000), '$17.5B'); // the screenshot case
    assert.equal(fmtDollarVolume(9_449_000_000), '$9.4B');
    assert.equal(fmtDollarVolume(1_224_000_000), '$1.2B');
    assert.equal(fmtDollarVolume(1_000_000_000), '$1.0B'); // exact boundary
  });

  it('returns an em dash for null / non-finite input', () => {
    assert.equal(fmtDollarVolume(null), '—');
    assert.equal(fmtDollarVolume(undefined), '—');
    assert.equal(fmtDollarVolume(Number.NaN), '—');
  });

  it('labels Canadian dollar volume explicitly', () => {
    assert.equal(fmtDollarVolume(25_000_000, 'CAD'), 'C$25M');
  });
});
