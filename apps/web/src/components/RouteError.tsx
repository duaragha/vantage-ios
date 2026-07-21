'use client';

import * as React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface RouteErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
  title?: string;
}

export function RouteError({
  error,
  reset,
  title = 'This view could not load',
}: RouteErrorProps): React.ReactElement {
  React.useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="cc-page flex min-h-[24rem] items-center justify-center">
      <div className="w-full max-w-lg border-y border-rose-500/25 py-8 text-center">
        <AlertTriangle className="mx-auto size-5 text-rose-300" />
        <h1 className="mt-3 text-lg font-semibold text-foreground">{title}</h1>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
          Vantage logged the failure. Retry once the data service is available.
        </p>
        {error.digest && (
          <div className="mt-2 font-mono text-[10px] text-muted-foreground/60">
            Reference {error.digest}
          </div>
        )}
        <button
          type="button"
          onClick={reset}
          className="mt-5 inline-flex min-h-10 items-center gap-2 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 text-xs font-medium text-rose-200 transition hover:bg-rose-500/15"
        >
          <RefreshCw className="size-3.5" />
          Retry
        </button>
      </div>
    </div>
  );
}
