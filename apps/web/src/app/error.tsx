'use client';

import * as React from 'react';
import { RouteError } from '@/components/RouteError';

export default function RootError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.ReactElement {
  return <RouteError {...props} title="Vantage could not load" />;
}
