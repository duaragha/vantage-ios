import * as React from 'react';
import { RouteTabs } from '@/components/RouteTabs';

const TABS = [
  {
    href: '/portfolio',
    label: 'Holdings',
    activePaths: ['/portfolio', '/positions'],
  },
  { href: '/theses', label: 'Thesis Health' },
];

export function PortfolioTabs(): React.ReactElement {
  return <RouteTabs tabs={TABS} />;
}
