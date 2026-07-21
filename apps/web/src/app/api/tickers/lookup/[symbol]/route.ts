/**
 * GET /api/tickers/lookup/:symbol — authenticated, returns company profile.
 *
 * Used by PositionForm's on-blur handler to pre-fill name + sector when the
 * user types a ticker. Auth enforced by root middleware.
 */

import { NextResponse } from 'next/server';
import { fetchCompanyProfile } from '@/lib/profile';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ symbol: string }> },
): Promise<Response> {
  const { symbol } = await ctx.params;
  const normalized = symbol.trim().toUpperCase();
  if (!/^[A-Z.-]{1,8}$/.test(normalized)) {
    return NextResponse.json({ error: 'invalid ticker' }, { status: 400 });
  }
  const profile = await fetchCompanyProfile(normalized);
  if (!profile) {
    return NextResponse.json({ error: 'profile unavailable', ticker: normalized }, { status: 404 });
  }
  return NextResponse.json(profile);
}
