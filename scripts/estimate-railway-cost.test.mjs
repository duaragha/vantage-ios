import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateRailwayCost } from './estimate-railway-cost.mjs';

test('estimates Railway usage from observed averages', () => {
  const report = estimateRailwayCost({
    budgetUsd: 10,
    services: [
      { name: 'web', avgMemoryGb: 0.2, avgCpu: 0.01, egressGb: 1 },
      { name: 'postgres', avgMemoryGb: 0.25, avgCpu: 0.02, volumeGb: 0.5 },
    ],
  });

  assert.ok(Math.abs(report.usageUsd - 5.225) < 1e-9);
  assert.equal(report.withinBudget, true);
  assert.equal(report.hobbyInvoiceFloorUsd, 5.225);
});

test('check result identifies a budget overrun', () => {
  const report = estimateRailwayCost({
    budgetUsd: 10,
    services: [{ name: 'worker', avgMemoryGb: 1, avgCpu: 0.1 }],
  });

  assert.equal(report.usageUsd, 12);
  assert.equal(report.withinBudget, false);
});

test('rejects invalid metric inputs', () => {
  assert.throws(
    () =>
      estimateRailwayCost({
        services: [{ name: 'web', avgMemoryGb: -1 }],
      }),
    /non-negative/,
  );
});
