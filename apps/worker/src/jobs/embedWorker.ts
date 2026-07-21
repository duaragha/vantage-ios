/**
 * Compatibility boundary for ingestion call sites.
 *
 * Article and thesis rows are their own durable embedding queue: the private
 * embedder's bounded batch selects rows whose pgvector column is NULL. Keeping
 * this tiny hook lets ingestion remain non-blocking while ensuring the
 * always-on worker never imports the ONNX runtime or loads the model.
 */

import type { FastifyBaseLogger } from 'fastify';

interface EmbedTask {
  articleId: number;
  headline: string;
  body: string | null;
}

let started = false;

/** The persisted Article row is enough for the external batch to discover it. */
export function enqueueArticleEmbedding(task: EmbedTask): void {
  void task;
}

/** Log ownership once so operators do not look for an in-worker queue. */
export function startEmbedWorker(logger: FastifyBaseLogger | Console = console): void {
  if (started) return;
  started = true;
  logger.info?.('embedding queue delegated to the shared embedder service');
}

export function stopEmbedWorker(): void {
  started = false;
}

export function embedQueueSize(): number {
  return 0;
}

export async function drainEmbedQueue(): Promise<void> {
  return Promise.resolve();
}
