/**
 * POST /api/auth/logout — destroys the iron-session cookie and redirects to /login.
 */

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getIronSession } from 'iron-session';
import { type AppSession, getSessionOptions } from '@/lib/auth';

export const runtime = 'nodejs';

export async function POST(req: Request): Promise<Response> {
  const store = await cookies();
  const session = await getIronSession<AppSession>(store, getSessionOptions());
  session.destroy();

  const url = new URL('/login', req.url);
  return NextResponse.redirect(url, { status: 303 });
}
