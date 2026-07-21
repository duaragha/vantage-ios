/**
 * Auth — single-password iron-session + bcrypt.
 *
 * The plaintext password is never persisted. The active bcrypt hash lives in
 * UserSettings; ADMIN_PASSWORD_HASH(_B64) is a break-glass fallback when the
 * database is unavailable or has not been initialized. Middleware enforces
 * the signed iron-session cookie on every dashboard route.
 */

import { getIronSession, type IronSession, type SessionOptions } from 'iron-session';
import { cookies } from 'next/headers';
import bcrypt from 'bcryptjs';
import { getSettings } from '@vantage/db';
import { SESSION_COOKIE_NAME } from './session-shared';

export interface AppSession {
  authenticated?: boolean;
  loggedInAt?: number;
}

/**
 * Build the iron-session config. The password MUST be ≥32 chars. We read it
 * lazily so builds don't explode if the env isn't populated at compile time.
 */
export function getSessionOptions(): SessionOptions {
  const password = process.env['SESSION_SECRET'];
  if (!password || password.length < 32) {
    throw new Error(
      'SESSION_SECRET is missing or shorter than 32 chars. Set it in .env before running the web app.',
    );
  }
  return {
    password,
    cookieName: SESSION_COOKIE_NAME,
    ttl: 60 * 60 * 24 * 7, // 7 days
    cookieOptions: {
      httpOnly: true,
      // Only require HTTPS when the dashboard is actually served over HTTPS
      // (for example, via Tailscale Serve). Plain HTTP on a tailnet is fine —
      // tailscale encrypts at the network layer. With `secure: true` over
      // HTTP, the browser refuses to send the cookie back on subsequent
      // requests, which manifests as "have to log in on every page".
      secure: process.env['DASHBOARD_BASE_URL']?.startsWith('https://') ?? false,
      sameSite: 'lax',
      path: '/',
    },
  };
}

/**
 * Get the current session via next/headers cookies. RSC / server-action safe.
 * Do NOT call from middleware (use `getIronSession(req, res, ...)` there).
 */
export async function getSession(): Promise<IronSession<AppSession>> {
  const store = await cookies();
  return getIronSession<AppSession>(store, getSessionOptions());
}

export async function isAuthed(): Promise<boolean> {
  const session = await getSession();
  return session.authenticated === true;
}

/**
 * Compare a plaintext password against the persisted hash, falling back to
 * ADMIN_PASSWORD_HASH(_B64) for recovery. Returns false when neither exists.
 */
export async function verifyPassword(plaintext: string): Promise<boolean> {
  const b64 = process.env['ADMIN_PASSWORD_HASH_B64'];
  const raw = process.env['ADMIN_PASSWORD_HASH'];
  const envHash = b64 ? Buffer.from(b64, 'base64').toString('utf8') : raw;
  let persistedHash: string | null = null;
  try {
    persistedHash = (await getSettings())?.passwordHash ?? null;
  } catch {
    // Keep the env hash as a break-glass login when Postgres is unavailable.
  }
  const hash = persistedHash ?? envHash;
  if (!hash) return false;
  if (!plaintext) return false;
  try {
    return await bcrypt.compare(plaintext, hash);
  } catch {
    return false;
  }
}

export { SESSION_COOKIE_NAME, isPublicPath } from './session-shared';
