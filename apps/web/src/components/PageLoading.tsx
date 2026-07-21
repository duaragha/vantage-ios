import * as React from 'react';

export function PageLoading({ label }: { label: string }): React.ReactElement {
  return (
    <div className="cc-page animate-pulse" aria-busy="true" aria-label={`Loading ${label}`}>
      <div className="h-3 w-24 rounded-sm bg-white/[0.06]" />
      <div className="mt-3 h-8 w-56 rounded-sm bg-white/[0.08]" />
      <div className="mt-3 h-4 w-80 max-w-full rounded-sm bg-white/[0.05]" />
      <div className="mt-8 border-y border-white/[0.06] py-5">
        <div className="grid grid-cols-4 gap-4">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="h-12 rounded-sm bg-white/[0.045]" />
          ))}
        </div>
      </div>
      <div className="mt-6 space-y-3">
        {Array.from({ length: 7 }, (_, index) => (
          <div key={index} className="h-11 rounded-sm bg-white/[0.04]" />
        ))}
      </div>
    </div>
  );
}
