/**
 * Session constants / path helpers — edge-runtime safe.
 *
 * Kept separate from `auth.ts` so the middleware (edge runtime) can import
 * these without pulling in bcryptjs or iron-session's Node-specific deps.
 */

export const SESSION_COOKIE_NAME = 'vantage-session';

export function isPublicPath(pathname: string): boolean {
  if (pathname === '/login') return true;
  if (pathname === '/api/health') return true;
  if (pathname === '/api/auth/login') return true;
  if (pathname === '/manifest.webmanifest') return true;
  if (pathname === '/sw.js') return true;
  if (pathname === '/icon-512.png') return true;
  if (pathname.startsWith('/api/v1/sidestore/')) return true;
  if (pathname.startsWith('/_next/')) return true;
  if (pathname.startsWith('/favicon')) return true;
  return false;
}
