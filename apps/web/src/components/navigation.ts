import {
  BookOpen,
  Briefcase,
  Crosshair,
  FlaskConical,
  MessageSquare,
  Newspaper,
  Radar,
  Settings,
  Wallet,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

export interface AppNavItem {
  href: string;
  label: string;
  mobileLabel?: string;
  icon: LucideIcon;
  activePaths?: string[];
}

export const PRIMARY_NAV: readonly AppNavItem[] = [
  {
    href: '/portfolio',
    label: 'Portfolio',
    icon: Briefcase,
    activePaths: ['/portfolio', '/positions', '/theses'],
  },
  {
    href: '/compare',
    label: 'Research',
    icon: Radar,
    activePaths: ['/compare', '/discovery', '/watchlist'],
  },
  { href: '/goals', label: 'Goals', icon: Crosshair },
  {
    href: '/insights',
    label: 'Insights',
    icon: Newspaper,
    activePaths: ['/insights', '/calendar'],
  },
  { href: '/chat', label: 'Chat', icon: MessageSquare },
];

export const UTILITY_NAV: readonly AppNavItem[] = [
  { href: '/accounts', label: 'Accounts', icon: Wallet },
  { href: '/backtest', label: 'Backtest', icon: FlaskConical },
  { href: '/guide', label: 'Guide', icon: BookOpen },
  { href: '/settings', label: 'Settings', icon: Settings },
  { href: '/ops', label: 'Ops', icon: Wrench },
];

export function isNavItemActive(pathname: string | null, item: AppNavItem): boolean {
  const paths = item.activePaths ?? [item.href];
  return paths.some((path) => pathname === path || pathname?.startsWith(`${path}/`));
}

export function mobileRouteLabel(pathname: string | null): string {
  if (!pathname) return 'Command center';
  if (pathname.startsWith('/positions/')) return 'Position';
  if (pathname === '/portfolio/add') return 'New position';
  if (pathname === '/portfolio/import') return 'Import';
  if (pathname.startsWith('/goals/')) return 'Goal plan';
  if (pathname === '/theses') return 'Thesis health';
  if (pathname === '/discovery') return 'Discovery';
  if (pathname === '/watchlist') return 'Watchlist';
  if (pathname === '/calendar') return 'Calendar';

  const item = [...PRIMARY_NAV, ...UTILITY_NAV].find((candidate) =>
    isNavItemActive(pathname, candidate),
  );
  return item?.label ?? 'Command center';
}
