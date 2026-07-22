import { NextResponse, type NextRequest } from 'next/server';
import {
  countActiveWebPushSubscriptions,
  disableWebPushSubscription,
  saveWebPushSubscription,
} from '@vantage/db';

export const runtime = 'nodejs';

interface SubscriptionBody {
  endpoint?: unknown;
  keys?: { p256dh?: unknown; auth?: unknown };
}

export async function GET(): Promise<Response> {
  return NextResponse.json({ active: await countActiveWebPushSubscriptions() });
}

export async function POST(request: NextRequest): Promise<Response> {
  const parsed = await readSubscription(request);
  if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });

  await saveWebPushSubscription({
    ...parsed.value,
    userAgent: request.headers.get('user-agent'),
  });
  return NextResponse.json(
    { ok: true, active: await countActiveWebPushSubscriptions() },
    { status: 201 },
  );
}

export async function DELETE(request: NextRequest): Promise<Response> {
  let body: SubscriptionBody;
  try {
    body = (await request.json()) as SubscriptionBody;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 });
  }
  if (typeof body.endpoint !== 'string' || !isValidEndpoint(body.endpoint)) {
    return NextResponse.json({ ok: false, error: 'invalid endpoint' }, { status: 400 });
  }
  await disableWebPushSubscription(body.endpoint);
  return NextResponse.json({ ok: true, active: await countActiveWebPushSubscriptions() });
}

async function readSubscription(
  request: NextRequest,
): Promise<
  | { ok: true; value: { endpoint: string; p256dh: string; auth: string } }
  | { ok: false; error: string }
> {
  let body: SubscriptionBody;
  try {
    body = (await request.json()) as SubscriptionBody;
  } catch {
    return { ok: false, error: 'invalid JSON' };
  }
  const endpoint = body.endpoint;
  const p256dh = body.keys?.p256dh;
  const auth = body.keys?.auth;
  if (typeof endpoint !== 'string' || !isValidEndpoint(endpoint)) {
    return { ok: false, error: 'invalid endpoint' };
  }
  if (typeof p256dh !== 'string' || !isBase64Url(p256dh, 40, 200)) {
    return { ok: false, error: 'invalid p256dh key' };
  }
  if (typeof auth !== 'string' || !isBase64Url(auth, 12, 100)) {
    return { ok: false, error: 'invalid auth key' };
  }
  return { ok: true, value: { endpoint, p256dh, auth } };
}

function isValidEndpoint(value: string): boolean {
  if (value.length > 4096) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function isBase64Url(value: string, min: number, max: number): boolean {
  return value.length >= min && value.length <= max && /^[A-Za-z0-9_-]+={0,2}$/.test(value);
}
