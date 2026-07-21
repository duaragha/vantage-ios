/**
 * Middleware — enforces iron-session auth on every non-public route.
 *
 * We resolve session state by reading the signed cookie directly via
 * `getIronSession` against the Next request/response pair. On missing /
 * invalid session we redirect to /login (with ?next=<original>).
 *
 * Runs on the edge by default; iron-session v8 is edge-compatible.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getIronSession } from 'iron-session';
import { isPublicPath, SESSION_COOKIE_NAME } from '@/lib/session-shared';

// Mirrors AppSession from lib/auth.ts; we re-declare here to avoid importing
// auth.ts (which pulls in bcryptjs, a Node-only dep) into the edge bundle.
interface AppSession {
  authenticated?: boolean;
  loggedInAt?: number;
}

export async function middleware(req: NextRequest): Promise<Response> {
  const { pathname, search } = req.nextUrl;

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  // Build a response we can attach Set-Cookie to if iron-session rotates anything.
  const res = NextResponse.next();

  // Middleware runs on the edge — SESSION_SECRET must be present at runtime.
  const password = process.env['SESSION_SECRET'];
  if (!password || password.length < 32) {
    // Fail safe: without a valid secret, never hand out a session.
    return redirectToLogin(req, pathname, search);
  }

  const session = await getIronSession<AppSession>(req, res, {
    password,
    cookieName: SESSION_COOKIE_NAME,
    ttl: 60 * 60 * 24 * 7,
    cookieOptions: {
      httpOnly: true,
      secure: process.env['DASHBOARD_BASE_URL']?.startsWith('https://') ?? false,
      sameSite: 'lax',
      path: '/',
    },
  });

  if (session.authenticated === true) {
    return res;
  }
  return redirectToLogin(req, pathname, search);
}

function redirectToLogin(req: NextRequest, pathname: string, search: string): Response {
  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = '/login';
  loginUrl.search = '';
  if (pathname !== '/' && pathname !== '/login') {
    loginUrl.searchParams.set('next', `${pathname}${search}`);
  }
  return NextResponse.redirect(loginUrl);
}

/**
 * Run on every path except static assets. The `isPublicPath` check inside
 * handles /login, /api/health, and the login POST endpoint.
 */
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|gif|webp)$).*)'],
};
