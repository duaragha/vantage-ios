/**
 * Drawer — minimal right-side sheet overlay.
 *
 * We avoid installing Radix's Dialog primitive for this one-off; the drawer
 * is self-contained, keyboard-accessible, and trivially themed.
 */

'use client';

import * as React from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  widthClassName?: string;
}

export function Drawer({
  open,
  onClose,
  title,
  description,
  children,
  widthClassName = 'w-full md:max-w-xl',
}: DrawerProps): React.ReactElement | null {
  const panelRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key !== 'Tab' || !panelRef.current) return;
      const focusable = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) {
        e.preventDefault();
        panelRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    window.requestAnimationFrame(() => panelRef.current?.focus());
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      previouslyFocused?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-end md:items-stretch"
      role="dialog"
      aria-modal="true"
      aria-labelledby="drawer-title"
      aria-describedby={description ? 'drawer-description' : undefined}
    >
      <button
        type="button"
        aria-label="Close drawer"
        onClick={onClose}
        className="absolute inset-0 bg-black/65 backdrop-blur-sm"
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        className={cn(
          'relative z-10 flex max-h-[92dvh] flex-col overflow-hidden rounded-t-[1.5rem] border-t border-white/[0.1] bg-[#0d0e10]/98 pb-[env(safe-area-inset-bottom)] shadow-2xl outline-none backdrop-blur-xl md:h-full md:max-h-none md:rounded-none md:border-l md:border-t-0 md:pb-0',
          widthClassName,
        )}
      >
        <div className="pt-2 md:hidden">
          <div className="mx-auto h-1 w-10 rounded-full bg-white/15" />
        </div>
        <div className="flex items-start justify-between border-b border-white/[0.06] px-4 py-4 sm:px-6 sm:py-5">
          <div>
            <h2 id="drawer-title" className="text-lg font-semibold tracking-tight">
              {title}
            </h2>
            {description && (
              <p id="drawer-description" className="mt-1 text-xs text-muted-foreground">
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex size-11 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition hover:bg-white/[0.06] hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="cc-scrollbar flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
          {children}
        </div>
      </div>
    </div>
  );
}
