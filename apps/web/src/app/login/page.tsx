/**
 * /login — single-password login.
 *
 * Server component. The form submits via a server action that validates
 * against the persisted settings hash (env hash is the recovery fallback),
 * writes the iron-session cookie, and redirects.
 */

import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { getIronSession } from 'iron-session';
import { type AppSession, getSessionOptions, isAuthed, verifyPassword } from '@/lib/auth';

interface LoginPageProps {
  searchParams: Promise<{ next?: string; error?: string }>;
}

export default async function LoginPage({
  searchParams,
}: LoginPageProps): Promise<React.ReactElement> {
  if (await isAuthed()) {
    redirect('/portfolio');
  }

  const sp = await searchParams;
  const nextPath = sanitizeNext(sp.next);
  const errorMessage =
    sp.error === 'invalid'
      ? 'That password did not match.'
      : sp.error === 'missing'
        ? 'Enter a password to sign in.'
        : null;

  async function login(formData: FormData): Promise<void> {
    'use server';
    const password = String(formData.get('password') ?? '');
    const next = sanitizeNext(String(formData.get('next') ?? ''));

    if (!password) {
      redirect(`/login?error=missing${next ? `&next=${encodeURIComponent(next)}` : ''}`);
    }
    const ok = await verifyPassword(password);
    if (!ok) {
      redirect(`/login?error=invalid${next ? `&next=${encodeURIComponent(next)}` : ''}`);
    }

    const store = await cookies();
    const session = await getIronSession<AppSession>(store, getSessionOptions());
    session.authenticated = true;
    session.loggedInAt = Date.now();
    await session.save();

    redirect(next || '/portfolio');
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 pb-[max(3rem,env(safe-area-inset-bottom))] pt-[max(3rem,env(safe-area-inset-top))] text-foreground sm:px-6">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
            <span className="relative inline-flex size-2">
              <span className="absolute inline-flex size-2 rounded-full bg-[var(--cc-accent)] opacity-60 cc-pulse" />
              <span className="relative inline-flex size-2 rounded-full bg-[var(--cc-accent)]" />
            </span>
            equity agent
          </div>
          <h1 className="mt-4 text-3xl font-semibold tracking-tight">Sign in</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Single-user dashboard. Password is set server-side.
          </p>
        </div>

        <form action={login} className="cc-panel flex flex-col gap-4 p-6 shadow-2xl">
          <input type="hidden" name="next" value={nextPath ?? ''} />
          <label className="flex flex-col gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
              Password
            </span>
            <input
              type="password"
              name="password"
              autoFocus
              autoComplete="current-password"
              className="h-12 rounded-md border border-white/[0.08] bg-black/30 px-3 text-base outline-none transition focus:border-[var(--cc-accent)]/60 focus:ring-2 focus:ring-[var(--cc-accent)]/30 sm:h-10 sm:text-sm"
              required
            />
          </label>

          {errorMessage && (
            <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 font-mono text-xs text-rose-300">
              {errorMessage}
            </div>
          )}

          <button
            type="submit"
            className="relative min-h-12 overflow-hidden rounded-md border border-[var(--cc-accent)]/30 bg-gradient-to-b from-[var(--cc-accent)]/20 to-transparent px-4 py-2 text-sm font-medium tracking-wide text-[var(--cc-accent)] transition hover:from-[var(--cc-accent)]/30 hover:to-[var(--cc-accent)]/5 sm:min-h-10"
          >
            Enter
          </button>
        </form>

        <div className="mt-8 text-center font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground/60">
          Not investment advice. Personal research tool.
        </div>
      </div>
    </main>
  );
}

/**
 * Only accept site-relative paths. Block protocol-relative (`//evil.com`) and
 * absolute URLs (`https://evil.com`).
 */
function sanitizeNext(next: string | undefined): string {
  if (!next) return '';
  if (!next.startsWith('/')) return '';
  if (next.startsWith('//')) return '';
  return next;
}
