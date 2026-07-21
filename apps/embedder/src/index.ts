import { buildServer } from './server.js';
import { positiveInteger, processPendingEmbeddings } from './lib/pending.js';

const port = Number(process.env['PORT'] ?? process.env['EMBEDDER_PORT'] ?? 3002);
const host = process.env['EMBEDDER_HOST'] ?? '0.0.0.0';

async function main(): Promise<void> {
  const server = buildServer();
  await server.listen({ port, host });

  const intervalMs = Number(process.env['EMBED_SWEEP_INTERVAL_MS'] ?? 0);
  let sweepTimer: NodeJS.Timeout | undefined;
  let sweepRunning = false;
  const sweep = async (): Promise<void> => {
    if (sweepRunning) return;
    sweepRunning = true;
    try {
      const summary = await processPendingEmbeddings({
        maxRows: positiveInteger(process.env['EMBED_MAX_ROWS'], 1_000, 10_000),
        queryBatchSize: positiveInteger(process.env['EMBED_QUERY_BATCH_SIZE'], 128, 500),
        log: server.log,
      });
      server.log.info(summary, 'embedding sweep complete');
    } catch (err) {
      server.log.error({ err }, 'embedding sweep failed');
    } finally {
      sweepRunning = false;
    }
  };

  if (Number.isFinite(intervalMs) && intervalMs >= 60_000) {
    const initialTimer = setTimeout(() => void sweep(), 5_000);
    initialTimer.unref();
    sweepTimer = setInterval(() => void sweep(), intervalMs);
    sweepTimer.unref();
    server.log.info({ intervalMs }, 'compose-mode embedding sweeps enabled');
  }

  const shutdown = async (signal: string): Promise<void> => {
    server.log.info({ signal }, 'shutting down embedder');
    if (sweepTimer) clearInterval(sweepTimer);
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
