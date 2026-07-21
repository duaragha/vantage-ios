/**
 * CLI invoker for the one-shot ETF seed job.
 *
 * Run from repo root:
 *   pnpm --filter @vantage/worker exec tsx --env-file=../../.env ../../scripts/seed-etfs.ts
 *
 * Or, more reliably, via the HTTP endpoint POST /jobs/seed/etfs (preferred
 * in containerized envs). This script is for ad-hoc local invocation when
 * the worker isn't running.
 */

import {
  seedEtfUniverse,
  ETF_SEED,
} from '../apps/worker/src/jobs/seedEtfUniverse.js';

async function main(): Promise<void> {
  console.log(`seed-etfs: starting (${ETF_SEED.length} tickers)`);
  const result = await seedEtfUniverse(console);
  console.log('seed-etfs: result');
  console.log(JSON.stringify(result, null, 2));
  if (result.failedTickers.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('seed-etfs: fatal', err);
  process.exit(1);
});
