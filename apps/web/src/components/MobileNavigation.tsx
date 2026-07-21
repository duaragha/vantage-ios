'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LogOut, Menu, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  PRIMARY_NAV,
  UTILITY_NAV,
  isNavItemActive,
  mobileRouteLabel,
} from '@/components/navigation';

export function MobileNavigation(): React.ReactElement {
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);
  const closeButtonRef = React.useRef<HTMLButtonElement>(null);
  const menuButtonRef = React.useRef<HTMLButtonElement>(null);
  const sheetRef = React.useRef<HTMLElement>(null);

  React.useEffect(() => {
    setOpen(false);
  }, [pathname]);

  React.useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const menuButton = menuButtonRef.current;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
      if (event.key !== 'Tab' || !sheetRef.current) return;
      const focusable = Array.from(
        sheetRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        event.preventDefault();
        sheetRef.current.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.body.style.overflow = 'hidden';
    window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = '';
      (previouslyFocused ?? menuButton)?.focus();
    };
  }, [open]);

  return (
    <>
      <header className="fixed inset-x-0 top-0 z-40 border-b border-white/[0.07] bg-[#090a0c]/90 pt-[env(safe-area-inset-top)] backdrop-blur-2xl lg:hidden">
        <div className="flex h-14 items-center justify-between px-4">
          <Link
            href="/portfolio"
            className="flex min-h-11 min-w-0 items-center gap-3 rounded-xl pr-3"
            aria-label="Vantage portfolio"
          >
            <span className="relative inline-flex size-2.5 shrink-0">
              <span className="absolute inline-flex size-2.5 rounded-full bg-[var(--cc-accent)] opacity-50 cc-pulse" />
              <span className="relative inline-flex size-2.5 rounded-full bg-[var(--cc-accent)] shadow-[0_0_12px_rgba(94,234,212,0.65)]" />
            </span>
            <span className="min-w-0 leading-tight">
              <span className="block text-[15px] font-semibold tracking-tight">Vantage</span>
              <span className="block truncate font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">
                {mobileRouteLabel(pathname)}
              </span>
            </span>
          </Link>
          <button
            ref={menuButtonRef}
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Open more navigation"
            aria-expanded={open}
            className="flex size-11 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.04] text-muted-foreground transition active:scale-95 active:bg-white/[0.08]"
          >
            <Menu className="size-5" />
          </button>
        </div>
      </header>

      <nav
        aria-label="Primary navigation"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-white/[0.08] bg-[#090a0c]/92 pb-[env(safe-area-inset-bottom)] backdrop-blur-2xl lg:hidden"
      >
        <div className="mx-auto flex h-16 max-w-lg items-stretch px-1.5">
          {PRIMARY_NAV.map((item) => {
            const Icon = item.icon;
            const active = isNavItemActive(pathname, item);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'relative flex min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-xl px-1 text-[10px] font-medium transition active:scale-95',
                  active ? 'text-[var(--cc-accent)]' : 'text-muted-foreground',
                )}
              >
                {active && (
                  <span className="absolute inset-x-3 top-0 h-px rounded-full bg-[var(--cc-accent)] shadow-[0_0_9px_var(--cc-accent)]" />
                )}
                <Icon
                  className={cn(
                    'size-[19px]',
                    active && 'drop-shadow-[0_0_6px_rgba(94,234,212,0.45)]',
                  )}
                />
                <span className="truncate">{item.mobileLabel ?? item.label}</span>
              </Link>
            );
          })}
        </div>
      </nav>

      {open && (
        <div
          className="fixed inset-0 z-50 lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-labelledby="mobile-more-title"
        >
          <button
            type="button"
            aria-label="Close more navigation"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
          />
          <section
            ref={sheetRef}
            tabIndex={-1}
            className="absolute inset-x-0 bottom-0 max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-t-[1.75rem] border-t border-white/[0.1] bg-[#101114] px-4 pb-[calc(1.25rem+env(safe-area-inset-bottom))] pt-3 outline-none shadow-[0_-20px_80px_rgba(0,0,0,0.65)]"
          >
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-white/15" />
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 id="mobile-more-title" className="text-lg font-semibold tracking-tight">
                  More
                </h2>
                <p className="text-xs text-muted-foreground">
                  Accounts, tools, and system controls
                </p>
              </div>
              <button
                ref={closeButtonRef}
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="flex size-11 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.04] text-muted-foreground"
              >
                <X className="size-5" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2">
              {UTILITY_NAV.map((item) => {
                const Icon = item.icon;
                const active = isNavItemActive(pathname, item);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex min-h-16 items-center gap-3 rounded-2xl border px-4 text-sm transition active:scale-[0.98]',
                      active
                        ? 'border-[var(--cc-accent)]/30 bg-[var(--cc-accent)]/10 text-[var(--cc-accent)]'
                        : 'border-white/[0.07] bg-white/[0.035] text-foreground/85',
                    )}
                  >
                    <Icon className="size-5 shrink-0" />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </div>

            <form action="/api/auth/logout" method="post" className="mt-3">
              <button
                type="submit"
                className="flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border border-rose-500/20 bg-rose-500/[0.06] text-sm text-rose-200"
              >
                <LogOut className="size-4" />
                Sign out
              </button>
            </form>
          </section>
        </div>
      )}
    </>
  );
}
