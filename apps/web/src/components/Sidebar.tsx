/**
 * Sidebar — persistent left-rail nav for the dashboard shell.
 *
 * Client component so active-route highlighting + logout form live here.
 */

'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LogOut } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  PRIMARY_NAV,
  UTILITY_NAV,
  isNavItemActive,
  type AppNavItem,
} from '@/components/navigation';

function NavLink({ item, active }: { item: AppNavItem; active: boolean }): React.ReactElement {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      className={cn(
        'group relative flex items-center gap-3 rounded-md px-3 py-2 text-sm transition',
        active
          ? 'bg-[var(--cc-accent)]/10 text-foreground'
          : 'text-muted-foreground hover:bg-white/[0.04] hover:text-foreground',
      )}
    >
      {active && (
        <span className="absolute left-0 top-1/2 h-6 w-0.5 -translate-y-1/2 rounded-full bg-[var(--cc-accent)] shadow-[0_0_8px_var(--cc-accent)]" />
      )}
      <Icon
        className={cn(
          'size-4 shrink-0',
          active ? 'text-[var(--cc-accent)]' : 'text-muted-foreground/70',
        )}
      />
      <span className="tracking-tight">{item.label}</span>
    </Link>
  );
}

export function Sidebar(): React.ReactElement {
  const pathname = usePathname();

  return (
    <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-white/[0.06] bg-black/40 backdrop-blur-xl lg:flex">
      <div className="flex items-center gap-2 px-5 py-6">
        <span className="relative inline-flex size-2">
          <span className="absolute inline-flex size-2 rounded-full bg-[var(--cc-accent)] opacity-60 cc-pulse" />
          <span className="relative inline-flex size-2 rounded-full bg-[var(--cc-accent)]" />
        </span>
        <div className="leading-tight">
          <div className="text-sm font-semibold tracking-tight">Vantage</div>
          <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            command center
          </div>
        </div>
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 px-2">
        {PRIMARY_NAV.map((item) => {
          const active = isNavItemActive(pathname, item);
          return <NavLink key={item.href} item={item} active={active} />;
        })}
      </nav>

      <div className="border-t border-white/[0.06] p-2">
        <div className="mb-2 flex flex-col gap-0.5">
          {UTILITY_NAV.map((item) => {
            const active = isNavItemActive(pathname, item);
            return <NavLink key={item.href} item={item} active={active} />;
          })}
        </div>
        <form action="/api/auth/logout" method="post">
          <button
            type="submit"
            className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition hover:bg-white/[0.04] hover:text-foreground"
          >
            <LogOut className="size-4" />
            <span>Sign out</span>
          </button>
        </form>
      </div>
    </aside>
  );
}
