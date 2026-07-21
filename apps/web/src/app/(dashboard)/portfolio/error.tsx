'use client';

import * as React from 'react';
import { RouteError } from '@/components/RouteError';

export default function PortfolioError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.ReactElement {
  return <RouteError {...props} title="Portfolio could not load" />;
}
