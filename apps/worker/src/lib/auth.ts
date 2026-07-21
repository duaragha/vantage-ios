/**
 * Worker auth — shared-secret header check.
 *
 * Every /jobs/* endpoint is gated on `x-worker-secret` matching WORKER_SECRET.
 * The constant-time compare avoids timing-based leakage on the value.
 */

import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

export class WorkerAuthError extends Error {
  readonly status = 401;
  constructor(message: string) {
    super(message);
    this.name = 'WorkerAuthError';
  }
}

export function getConfiguredSecret(): string {
  const s = process.env['WORKER_SECRET'];
  if (!s || s.length < 8) {
    throw new WorkerAuthError(
      'WORKER_SECRET is not set or too short (min 8 chars) — refusing to start auth middleware',
    );
  }
  return s;
}

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * Fastify preHandler hook — install on any route group that needs worker auth.
 */
export async function requireWorkerSecret(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const expected = getConfiguredSecret();
  const headerRaw = req.headers['x-worker-secret'];
  const provided =
    typeof headerRaw === 'string'
      ? headerRaw
      : Array.isArray(headerRaw)
        ? headerRaw[0]
        : undefined;

  if (!provided || !safeEqual(provided, expected)) {
    await reply.code(401).send({ error: 'unauthorized' });
  }
}
