/**
 * /api/backtest — proxy to the worker's POST /jobs/backtest/run.
 *
 * The worker secret lives in the server-side env only; the browser never sees
 * it. The client POSTs JSON here; we forward it with the `x-worker-secret`
 * header and return the worker's response verbatim.
 */

import { NextResponse } from 'next/server';
import { componentLogger } from '@vantage/notify';
import { isAuthed } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const WORKER_URL = process.env.WORKER_URL ?? 'http://localhost:3001';
const log = componentLogger('web/api/backtest');

export async function POST(req: Request): Promise<Response> {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const secret = process.env.WORKER_SECRET;
  if (!secret) {
    log.error('backtest proxy: WORKER_SECRET is not configured');
    return NextResponse.json({ error: 'backtest unavailable' }, { status: 500 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${WORKER_URL}/jobs/backtest/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-worker-secret': secret,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    log.error({ err }, 'backtest proxy: worker unreachable');
    return NextResponse.json({ error: 'backtest worker unavailable' }, { status: 502 });
  }

  const text = await upstream.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A successful worker response should always be JSON. Keep raw payloads
    // server-side so an upstream stack/error page cannot leak to the browser.
  }

  const workerError =
    parsed && typeof parsed === 'object' && 'error' in parsed
      ? (parsed as { error?: unknown }).error
      : null;
  if (!upstream.ok || (typeof workerError === 'string' && workerError.length > 0)) {
    log.warn({ status: upstream.status, workerError }, 'backtest worker rejected request');
    const status = upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502;
    const safeError =
      upstream.status === 400 && typeof workerError === 'string'
        ? workerError
        : 'backtest request failed';
    return NextResponse.json({ error: safeError }, { status });
  }
  if (parsed === null) {
    log.error({ status: upstream.status }, 'backtest worker returned invalid JSON');
    return NextResponse.json({ error: 'backtest worker unavailable' }, { status: 502 });
  }
  return NextResponse.json(parsed, { status: upstream.status });
}
