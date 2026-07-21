import { buildServer } from './server.js';
import { CRON_SPECS, startCron } from './cron.js';
import { startEmbedWorker } from './jobs/embedWorker.js';
import { startRelevanceFilter } from './jobs/relevanceFilter.js';
import { configurePriceOracle } from '@vantage/core';
import { verifyChatId } from '@vantage/notify';
import { getBySymbol } from '@vantage/db';
import { startJobWatchdog } from './lib/jobWatchdog.js';
import { closeStaleJobRuns } from './lib/staleJobRuns.js';
import { getAlpaca, getFinnhub, getTiingo, getYFinance } from './lib/adapters.js';

const PORT = Number(process.env['WORKER_PORT'] ?? 3001);
const HOST = process.env['WORKER_HOST'] ?? '0.0.0.0';

async function main(): Promise<void> {
  const server = buildServer();

  try {
    await server.listen({ port: PORT, host: HOST });
    server.log.info(`worker listening on http://${HOST}:${PORT}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }

  // Wire the rebalance engine's price oracle to the real adapters. Each
  // getter is lazy + throws if env vars aren't set — the oracle's safeCall
  // wrapper converts that into "skip this provider". `exchangeLookup` is
  // Phase 16: the oracle routes CA tickers to yfinance and US tickers to
  // Alpaca, Finnhub, yfinance, then Tiingo.
  configurePriceOracle({
    getAlpaca,
    getFinnhub,
    getTiingo,
    getYFinance,
    logger: server.log,
    exchangeLookup: async (ticker) => {
      try {
        const row = await getBySymbol(ticker);
        return row?.exchange ?? null;
      } catch (err) {
        server.log.warn({ ticker, err }, 'price-oracle exchange lookup failed');
        return null;
      }
    },
  });

  // Telegram verification — if the token is set but the chat_id is bad, we
  // want to know at boot, not when the first digest goes out.
  if (process.env['TELEGRAM_BOT_TOKEN']) {
    try {
      const ok = await verifyChatId();
      if (!ok) {
        server.log.error(
          { event: 'telegram-verify-failed' },
          'Telegram configured but chat_id invalid (verifyChatId returned false)',
        );
      } else {
        server.log.info({ event: 'telegram-verify-ok' }, 'Telegram bot + chat_id verified');
      }
    } catch (err) {
      server.log.error({ event: 'telegram-verify-error', err }, 'Telegram verification threw');
    }
  } else {
    server.log.info('TELEGRAM_BOT_TOKEN not set — Telegram delivery disabled');
  }

  // Background workers that are not represented in CRON_SPECS.
  startEmbedWorker(server.log);
  startRelevanceFilter(server.log);

  // Recover rows abandoned by an earlier worker before the new scheduler
  // starts. This keeps Ops truthful after container restarts or hard exits.
  try {
    await closeStaleJobRuns(server.log);
  } catch (err) {
    server.log.error({ err }, 'stale JobRun cleanup failed');
  }

  // Croner owns the production schedules. The watchdog deliberately uses
  // native timers so a scheduler-library regression cannot silence both.
  const scheduledJobs = startCron(server.log);
  const watchdog = startJobWatchdog(CRON_SPECS, server.log);

  const shutdown = async (signal: string): Promise<void> => {
    server.log.info({ signal }, 'shutting down worker');
    watchdog.stop();
    for (const job of scheduledJobs) job.stop();
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
