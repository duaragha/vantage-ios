import { NextResponse } from 'next/server';
import { fetchLivePrice } from '@/lib/prices';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ ticker: string }> },
): Promise<Response> {
  const { ticker } = await ctx.params;
  const normalized = ticker.trim().toUpperCase();
  if (!/^[A-Z.-]{1,8}$/.test(normalized)) {
    return NextResponse.json({ error: 'invalid ticker' }, { status: 400 });
  }
  const price = await fetchLivePrice(normalized);
  if (!price) {
    return NextResponse.json({ error: 'price unavailable', ticker: normalized }, { status: 404 });
  }
  return NextResponse.json(price);
}
