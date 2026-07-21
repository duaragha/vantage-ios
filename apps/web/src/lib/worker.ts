/**
 * Worker client — proxy helper for hitting the Fastify worker.
 *
 * Usage (server only):
 *   const res = await callWorker('/jobs/thesis/evaluate/42', { method: 'POST' });
 *
 * Never import this from a client component; it reads WORKER_SECRET from env.
 */

import { componentLogger } from '@vantage/notify';

const log = componentLogger('web/lib/worker');

export interface CallWorkerOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Extra headers (do NOT pass x-worker-secret — we inject it). */
  headers?: Record<string, string>;
  /** Preserve a structured non-2xx body for read-only diagnostics such as deep health. */
  includeErrorData?: boolean;
}

export interface WorkerCallResult<T = unknown> {
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
}

const DEFAULT_URL = 'http://localhost:3001';

export async function callWorker<T = unknown>(
  path: string,
  options: CallWorkerOptions = {},
): Promise<WorkerCallResult<T>> {
  const secret = process.env['WORKER_SECRET'];
  const base = process.env['WORKER_URL'] ?? DEFAULT_URL;
  if (!secret) {
    log.error('worker request blocked: WORKER_SECRET is not configured');
    return {
      ok: false,
      status: 500,
      data: null,
      error: 'worker unavailable',
    };
  }

  // Only set content-type when a body is actually present. Fastify rejects
  // POST requests with a JSON content-type and an empty body.
  const hasBody = options.body !== undefined;
  const headers: Record<string, string> = {
    'x-worker-secret': secret,
    ...options.headers,
  };
  if (hasBody) headers['content-type'] = 'application/json';

  const init: RequestInit = {
    method: options.method ?? 'GET',
    headers,
    cache: 'no-store',
  };
  if (hasBody) {
    init.body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(`${base}${path}`, init);
  } catch (err) {
    log.error({ err, path }, 'worker request failed');
    return {
      ok: false,
      status: 502,
      data: null,
      error: 'worker unavailable',
    };
  }

  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  const envelopeError =
    typeof parsed === 'object' && parsed !== null && 'error' in parsed
      ? (parsed as { error: unknown }).error
      : null;
  if (!response.ok || (typeof envelopeError === 'string' && envelopeError.length > 0)) {
    log.warn(
      { path, status: response.status, workerError: envelopeError },
      'worker rejected request',
    );
    return {
      ok: false,
      status: response.ok ? 502 : response.status,
      data: options.includeErrorData ? (parsed as T) : null,
      error: 'worker request failed',
    };
  }

  return {
    ok: true,
    status: response.status,
    data: parsed as T,
    error: null,
  };
}
