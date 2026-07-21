import * as React from 'react';

export function DbErrorBanner({ message }: { message: string | null }): React.ReactElement | null {
  if (!message) return null;
  return (
    <div className="mb-6 rounded-md border border-amber-500/35 bg-amber-500/[0.08] px-3 py-2 text-xs text-amber-200">
      Data is temporarily unavailable. Retry after the data service is back.
    </div>
  );
}
