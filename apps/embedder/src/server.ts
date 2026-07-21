import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { EMBEDDING_DIM, EMBEDDING_MODEL, embedBatch } from '@vantage/embed';
import { positiveInteger, processPendingEmbeddings } from './lib/pending.js';

const MAX_TEXTS = 32;
const MAX_TEXT_LENGTH = 12_000;

function configuredSecret(): string | undefined {
  return process.env['EMBEDDER_SECRET']?.trim() || process.env['WORKER_SECRET']?.trim();
}

function authorized(request: FastifyRequest): boolean {
  const expected = configuredSecret();
  if (!expected) return process.env['NODE_ENV'] !== 'production';
  return request.headers['x-embedder-secret'] === expected;
}

export function buildServer(): FastifyInstance {
  const server = Fastify({ logger: true });

  server.get('/health', async () => ({
    ok: true,
    service: 'vantage-embedder',
    model: EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIM,
  }));

  server.post<{ Body: { texts?: unknown } }>('/v1/embeddings', async (request, reply) => {
    if (!authorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const texts = request.body?.texts;
    if (
      !Array.isArray(texts) ||
      texts.length === 0 ||
      texts.length > MAX_TEXTS ||
      !texts.every(
        (text) =>
          typeof text === 'string' && text.trim().length > 0 && text.length <= MAX_TEXT_LENGTH,
      )
    ) {
      return reply.code(400).send({
        error: `texts must contain 1-${MAX_TEXTS} non-empty strings up to ${MAX_TEXT_LENGTH} characters`,
      });
    }

    const vectors = await embedBatch(texts as string[]);
    return { model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIM, vectors };
  });

  server.post('/internal/embed-pending', async (request, reply) => {
    if (!authorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const summary = await processPendingEmbeddings({
      maxRows: positiveInteger(process.env['EMBED_MAX_ROWS'], 1_000, 10_000),
      queryBatchSize: positiveInteger(process.env['EMBED_QUERY_BATCH_SIZE'], 128, 500),
      log: server.log,
    });
    return { ok: true, ...summary };
  });

  return server;
}
