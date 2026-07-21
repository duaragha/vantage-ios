'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

export interface RouteTab {
  href: string;
  label: string;
  activePaths?: string[];
}

export function RouteTabs({
  tabs,
  className,
}: {
  tabs: RouteTab[];
  className?: string;
}): React.ReactElement {
  const pathname = usePathname();

  return (
    <div
      className={cn(
        'cc-hide-scrollbar flex w-full snap-x snap-mandatory overflow-x-auto rounded-xl border border-white/[0.08] bg-black/20 p-1 sm:inline-flex sm:w-auto sm:rounded-md',
        className,
      )}
    >
      {tabs.map((tab) => {
        const active = isActive(pathname, tab);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex min-h-10 flex-1 snap-start items-center justify-center whitespace-nowrap rounded-lg px-3 py-2 font-mono text-[10px] uppercase tracking-[0.16em] transition active:scale-[0.98] sm:min-h-0 sm:flex-none sm:rounded sm:py-1.5 sm:tracking-[0.2em]',
              active
                ? 'bg-[var(--cc-accent)]/10 text-[var(--cc-accent)]'
                : 'text-muted-foreground hover:bg-white/[0.04] hover:text-foreground',
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}

function isActive(pathname: string | null, tab: RouteTab): boolean {
  const paths = tab.activePaths ?? [tab.href];
  return paths.some((path) => pathname === path || pathname?.startsWith(`${path}/`));
}
