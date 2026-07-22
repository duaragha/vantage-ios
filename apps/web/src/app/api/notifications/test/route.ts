import { NextResponse } from 'next/server';
import { callWorker } from '@/lib/worker';

export const runtime = 'nodejs';

export async function POST(): Promise<Response> {
  const result = await callWorker<{ ok?: boolean; error?: string }>(
    '/jobs/app-notifications/test',
    { method: 'POST' },
  );
  if (!result.ok || result.data?.ok !== true) {
    return NextResponse.json(
      { ok: false, error: result.data?.error ?? 'Test notification could not be delivered.' },
      { status: result.status >= 400 && result.status < 600 ? result.status : 502 },
    );
  }
  return NextResponse.json({ ok: true });
}
