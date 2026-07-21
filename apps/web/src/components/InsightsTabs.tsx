import * as React from 'react';
import { RouteTabs } from '@/components/RouteTabs';

const TABS = [
  { href: '/insights', label: 'Feed' },
  { href: '/calendar', label: 'Scheduled' },
];

export function InsightsTabs(): React.ReactElement {
  return <RouteTabs tabs={TABS} />;
}
