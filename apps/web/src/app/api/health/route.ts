/**
 * GET /api/health — unauthenticated liveness probe.
 *
 * Used by the middleware public-path list + external monitors (e.g. the
 * laptop → gaming PC ping). Deliberately does not hit the DB.
 */

import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

export function GET(): Response {
  return NextResponse.json({ ok: true, ts: new Date().toISOString() });
}
