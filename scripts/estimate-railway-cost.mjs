#!/usr/bin/env node
/* global process */

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const RAILWAY_RATES = Object.freeze({
  memoryGbMonth: 10,
  cpuMonth: 20,
  egressGb: 0.05,
  volumeGbMonth: 0.15,
});

function nonNegative(value, label) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return parsed;
}

export function estimateRailwayCost(input) {
  if (!Array.isArray(input?.services) || input.services.length === 0) {
    throw new Error('input.services must contain at least one service');
  }

  const services = input.services.map((service, index) => {
    const name = String(service?.name ?? '').trim();
    if (!name) throw new Error(`services[${index}].name is required`);

    const avgMemoryGb = nonNegative(service.avgMemoryGb, `${name}.avgMemoryGb`);
    const avgCpu = nonNegative(service.avgCpu, `${name}.avgCpu`);
    const egressGb = nonNegative(service.egressGb, `${name}.egressGb`);
    const volumeGb = nonNegative(service.volumeGb, `${name}.volumeGb`);
    const memoryUsd = avgMemoryGb * RAILWAY_RATES.memoryGbMonth;
    const cpuUsd = avgCpu * RAILWAY_RATES.cpuMonth;
    const egressUsd = egressGb * RAILWAY_RATES.egressGb;
    const volumeUsd = volumeGb * RAILWAY_RATES.volumeGbMonth;

    return {
      name,
      memoryUsd,
      cpuUsd,
      egressUsd,
      volumeUsd,
      totalUsd: memoryUsd + cpuUsd + egressUsd + volumeUsd,
    };
  });

  const usageUsd = services.reduce((sum, service) => sum + service.totalUsd, 0);
  const budgetUsd = nonNegative(input.budgetUsd ?? 10, 'budgetUsd');
  return {
    services,
    usageUsd,
    hobbyInvoiceFloorUsd: Math.max(5, usageUsd),
    budgetUsd,
    withinBudget: usageUsd <= budgetUsd,
  };
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    throw new Error('usage: node scripts/estimate-railway-cost.mjs <metrics.json> [--check]');
  }

  const report = estimateRailwayCost(JSON.parse(await readFile(inputPath, 'utf8')));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (process.argv.includes('--check') && !report.withinBudget) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
