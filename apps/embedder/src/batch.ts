import { prisma } from '@vantage/db';
import { positiveInteger, processPendingEmbeddings } from './lib/pending.js';

async function main(): Promise<void> {
  try {
    const summary = await processPendingEmbeddings({
      maxRows: positiveInteger(process.env['EMBED_MAX_ROWS'], 1_000, 10_000),
      queryBatchSize: positiveInteger(process.env['EMBED_QUERY_BATCH_SIZE'], 128, 500),
      log: console,
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...summary })}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
