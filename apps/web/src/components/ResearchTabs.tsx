import * as React from 'react';
import { RouteTabs } from '@/components/RouteTabs';

const TABS = [
  { href: '/compare', label: 'Compare' },
  { href: '/discovery', label: 'Discovery' },
  { href: '/watchlist', label: 'Watchlist' },
];

export function ResearchTabs(): React.ReactElement {
  return <RouteTabs tabs={TABS} />;
}
