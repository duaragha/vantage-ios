'use client';

import * as React from 'react';
import { RouteError } from '@/components/RouteError';

export default function PositionError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.ReactElement {
  return <RouteError {...props} title="Position research could not load" />;
}
