import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { passesRotationSignalGate } from '../discover/rotation.js';
import {
  applyRotationToConcentration,
  buildReplacementActionState,
  isDiscoveryReplacementDataFresh,
  replacementNoteForState,
  requiredTrimValueUsd,
  selectCapTrimTickers,
} from './engine.js';
import { checkCaps, type ConcentrationResult } from './metrics.js';

function concentration(): ConcentrationResult {
  const positionPcts = [
    {
      ticker: 'AAA',
      sector: 'Technology',
      shares: 300,
      pricePerShare: 100,
      nativeValue: 30_000,
      value: 30_000,
      currency: 'USD' as const,
      pct: 30,
      pricedFromMarket: true,
    },
    {
      ticker: 'BBB',
      sector: 'Financials',
      shares: 250,
      pricePerShare: 100,
      nativeValue: 25_000,
      value: 25_000,
      currency: 'USD' as const,
      pct: 25,
      pricedFromMarket: true,
    },
    {
      ticker: 'CCC',
      sector: 'Healthcare',
      shares: 250,
      pricePerShare: 100,
      nativeValue: 25_000,
      value: 25_000,
      currency: 'USD' as const,
      pct: 25,
      pricedFromMarket: true,
    },
    {
      ticker: 'DDD',
      sector: 'Industrials',
      shares: 200,
      pricePerShare: 100,
      nativeValue: 20_000,
      value: 20_000,
      currency: 'USD' as const,
      pct: 20,
      pricedFromMarket: true,
    },
  ];
  return {
    totalValue: 100_000,
    totalValueCad: 136_000,
    usdCadRate: 1.36,
    positionPcts,
    sectorPcts: positionPcts.map((position) => ({
      sector: position.sector,
      value: position.value,
      pct: position.pct,
    })),
    topHoldings: positionPcts.map((position) => ({ ...position })),
    pricesResolved: 4,
  };
}

describe('cap-driven replacement logic', () => {
  it('lets an Intact cap trim use a good standalone candidate without the thesis delta gate', () => {
    assert.equal(
      passesRotationSignalGate({
        candidateScore: 0.4,
        heldHealth: 0.1,
        capDriven: true,
      }),
      true,
    );
    assert.equal(
      passesRotationSignalGate({
        candidateScore: 0.4,
        heldHealth: 0.1,
        capDriven: false,
      }),
      false,
    );
  });

  it('selects the violating ticker and the largest holding in a violated sector', () => {
    const selected = selectCapTrimTickers(concentration(), [
      { kind: 'single', ticker: 'BBB', pct: 30, cap: 25, overBy: 5 },
      { kind: 'sector', sector: 'Technology', pct: 40, cap: 30, overBy: 10 },
    ]);
    assert.deepEqual(new Set(selected), new Set(['AAA', 'BBB']));
  });

  it('sizes a dollar-neutral rotation to remove the original cap breach', () => {
    const running = concentration();
    const required = requiredTrimValueUsd({
      running,
      trimTicker: 'AAA',
      trimSector: 'Technology',
      buySector: 'Utilities',
      violationTickers: new Set(['AAA']),
      violationSectors: new Set(),
      settings: { singlePositionCapPct: 25, sectorCapPct: 100 },
    });
    assert.equal(required, 5_000);

    const next = applyRotationToConcentration({
      running,
      trimTicker: 'AAA',
      trimShares: 50,
      trimPrice: {
        price: 100,
        currency: 'USD',
        exchange: 'US',
        source: 'finnhub',
        asOf: new Date('2026-07-16T16:00:00Z'),
      },
      buyTicker: 'EEE',
      buyShares: 50,
      buyPrice: {
        price: 100,
        currency: 'USD',
        exchange: 'US',
        source: 'finnhub',
        asOf: new Date('2026-07-16T16:00:00Z'),
      },
      buySector: 'Utilities',
    });

    assert.equal(next.totalValue, 100_000);
    assert.equal(next.positionPcts.find((position) => position.ticker === 'AAA')?.pct, 25);
    assert.equal(next.positionPcts.find((position) => position.ticker === 'EEE')?.pct, 5);
    assert.deepEqual(
      checkCaps(next, { singlePositionCapPct: 25, sectorCapPct: 100 }).violations,
      [],
    );
  });

  it('keeps cross-currency rotation value neutral at the snapshot FX rate', () => {
    const next = applyRotationToConcentration({
      running: concentration(),
      trimTicker: 'AAA',
      trimShares: 10,
      trimPrice: {
        price: 136,
        currency: 'CAD',
        exchange: 'TO',
        source: 'twelvedata',
        asOf: new Date('2026-07-16T16:00:00Z'),
      },
      buyTicker: 'EEE',
      buyShares: 10,
      buyPrice: {
        price: 100,
        currency: 'USD',
        exchange: 'US',
        source: 'finnhub',
        asOf: new Date('2026-07-16T16:00:00Z'),
      },
      buySector: 'Utilities',
    });
    assert.equal(next.positionPcts.find((position) => position.ticker === 'AAA')?.value, 29_000);
    assert.equal(next.positionPcts.find((position) => position.ticker === 'EEE')?.value, 1_000);
    assert.equal(next.totalValue, 100_000);
  });
});

describe('replacement state honesty', () => {
  it('distinguishes a stale source from no candidate clearing the bar', () => {
    const now = new Date('2026-07-16T18:00:00Z');
    assert.equal(isDiscoveryReplacementDataFresh(new Date('2026-07-13T18:00:00Z'), now), true);
    assert.equal(isDiscoveryReplacementDataFresh(new Date('2026-07-13T17:59:59Z'), now), false);
    assert.match(replacementNoteForState('source-unavailable'), /missing or stale/i);
    assert.match(replacementNoteForState('none-cleared'), /No candidate cleared/);
    assert.deepEqual(
      buildReplacementActionState({ considered: true, found: false, state: 'none-cleared' }),
      {
        replacementConsidered: true,
        replacementFound: false,
        replacementState: 'none-cleared',
        replacementNote:
          'No candidate cleared the goal fit, cooldown, same-account, dollar-neutral, and post-swap cap checks.',
      },
    );
  });
});
