'use client';

import * as React from 'react';
import { RouteError } from '@/components/RouteError';

export default function DiscoveryError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.ReactElement {
  return <RouteError {...props} title="Discovery could not load" />;
}
