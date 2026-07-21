import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runBacktest, type BacktestConfig } from './engine.js';

const BASE_CONFIG: BacktestConfig = {
  startDate: new Date('2026-01-01T00:00:00.000Z'),
  endDate: new Date('2026-02-01T00:00:00.000Z'),
  strategy: 'monthly-allocation',
  initialCashUsd: 10_000,
  monthlyBudgetUsd: 500,
  caps: { singlePositionCapPct: 25, sectorCapPct: 60 },
};

async function rejectsConfig(overrides: Partial<BacktestConfig>, expected: RegExp): Promise<void> {
  await assert.rejects(
    runBacktest(
      { ...BASE_CONFIG, ...overrides },
      {
        persist: false,
        tiingo: {
          getDailyPrices: async () => {
            throw new Error('provider should not be called for invalid config');
          },
        },
      },
    ),
    expected,
  );
}

describe('runBacktest config validation', () => {
  it('rejects non-finite money and caps before calling a provider', async () => {
    await rejectsConfig({ initialCashUsd: Number.POSITIVE_INFINITY }, /initialCashUsd/);
    await rejectsConfig({ monthlyBudgetUsd: Number.NaN }, /monthlyBudgetUsd/);
    await rejectsConfig(
      { caps: { singlePositionCapPct: Number.POSITIVE_INFINITY, sectorCapPct: 60 } },
      /singlePositionCapPct/,
    );
  });

  it('rejects malformed strategy and position data', async () => {
    await rejectsConfig({ strategy: 'made-up' as BacktestConfig['strategy'] }, /invalid strategy/);
    await rejectsConfig(
      {
        seedPositions: [
          { ticker: 'AAPL', shares: 1, avgCost: 100 },
          { ticker: 'aapl', shares: 2, avgCost: 90 },
        ],
      },
      /duplicated/,
    );
    await rejectsConfig(
      { seedPositions: [{ ticker: 'AAPL', shares: Number.NaN, avgCost: 100 }] },
      /shares/,
    );
  });

  it('rejects malformed universes, sectors, and catalyst bounds', async () => {
    await rejectsConfig({ candidateUniverse: ['not a ticker!'] }, /candidateUniverse/);
    await rejectsConfig({ sectors: { AAPL: '' } }, /sector for AAPL/);
    await rejectsConfig({ holdingDays: 2_521 }, /holdingDays/);
    await rejectsConfig({ catalystMaxPerDay: 0 }, /catalystMaxPerDay/);
  });
});
