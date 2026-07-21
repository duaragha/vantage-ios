/**
 * /compare — "Holdings vs Market" command-center view.
 *
 * Server component. Pulls the latest DiscoveryScore batch (held + unheld in
 * one cohort courtesy of scoreHoldings in the nightly compute), ranks by
 * score, and renders:
 *   1. Unified table — held positions and top discovered candidates side by
 *      side, with held rows tinted and a 🟢/⚪ ownership dot.
 *   2. Top-swap panel — best held-vs-candidate pair by score delta, with a
 *      plain-English explanation derived deterministically from the signal
 *      breakdown.
 *
 * Empty states:
 *   - No open positions → prompt to add one.
 *   - No scores at all → prompt to trigger a compute.
 */

import * as React from 'react';
import { DEFAULT_WEIGHTS } from '@vantage/core/discover/signals';
import { FrostedPanel } from '@/components/FrostedPanel';
import { loadCompareData } from './data';
import { CompareRefreshButton } from './CompareRefreshButton';
import { CompareTable } from './CompareTable';
import { SwapPanel } from './SwapPanel';
import { VerdictLegend } from './VerdictLegend';
import { ResearchTabs } from '@/components/ResearchTabs';
import { DbErrorBanner } from '@/components/DbErrorBanner';

export const dynamic = 'force-dynamic';

export default async function ComparePage(): Promise<React.ReactElement> {
  let data: Awaited<ReturnType<typeof loadCompareData>> | null = null;
  let dbError: string | null = null;
  try {
    data = await loadCompareData();
  } catch (err) {
    dbError = err instanceof Error ? err.message : 'database unreachable';
  }

  const heldCount = data?.heldCount ?? 0;
  const unheldCount = data?.unheldCount ?? 0;
  const computedAt = data?.computedAt ?? null;
  const rows = data?.rows ?? [];
  const swaps = data?.swaps ?? [];

  return (
    <div className="cc-page">
      <header className="cc-page-header items-start">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
            compare
          </div>
          <h1 className="cc-page-title">Holdings vs Market</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Your positions scored against the same discovery engine that ranks the market. A
            candidate only matters if it beats what you already own — this page tells you whether it
            does.
          </p>
          <div className="mt-3">
            <VerdictLegend />
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground/80">
            <div>
              <span className="text-foreground/80">{heldCount}</span> held
            </div>
            <div>
              <span className="text-foreground/80">{unheldCount}</span> candidates
            </div>
            <div>
              {computedAt ? (
                <>as of {new Date(computedAt).toLocaleString('en-CA')}</>
              ) : (
                'no compute yet'
              )}
            </div>
          </div>
          <CompareRefreshButton />
        </div>
      </header>

      <div className="mb-6">
        <ResearchTabs />
      </div>

      <DbErrorBanner message={dbError} />

      {heldCount === 0 && (
        <FrostedPanel className="mb-6">
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
              No holdings tracked
            </div>
            <p className="max-w-md text-sm text-muted-foreground">
              Add a position to see how the market compares. Head to{' '}
              <a
                href="/portfolio"
                className="text-[var(--cc-accent)] underline-offset-2 hover:underline"
              >
                Portfolio
              </a>{' '}
              to open one.
            </p>
          </div>
        </FrostedPanel>
      )}

      {/* Unified ranking table */}
      <section className="mb-8">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold tracking-tight text-foreground/90">
            Unified ranking
          </h2>
          <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground/70">
            held + top candidates, score desc
          </div>
        </div>
        <FrostedPanel padding="none" className="overflow-hidden">
          {rows.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-16 text-center">
              <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
                No scores yet
              </div>
              <p className="max-w-md text-sm text-muted-foreground">
                Discovery runs nightly at 6pm ET. Hit{' '}
                <span className="font-mono text-foreground/70">Refresh</span> above to trigger a
                compute, or seed a couple of positions in{' '}
                <a
                  href="/portfolio"
                  className="text-[var(--cc-accent)] underline-offset-2 hover:underline"
                >
                  Portfolio
                </a>{' '}
                and kick a run from{' '}
                <a
                  href="/settings"
                  className="text-[var(--cc-accent)] underline-offset-2 hover:underline"
                >
                  Settings
                </a>
                .
              </p>
            </div>
          ) : (
            <CompareTable
              rows={rows}
              signalWeights={data?.signalWeights ?? DEFAULT_WEIGHTS}
              swapTickers={swaps.map((swap) => swap.trimTicker)}
            />
          )}
        </FrostedPanel>
      </section>

      {/* Best swaps */}
      <section>
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold tracking-tight text-foreground/90">Top swaps</h2>
          <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground/70">
            delta &ge; 0.30 · trigger ≥ 0.60
          </div>
        </div>
        <SwapPanel swaps={swaps} heldCount={heldCount} />
      </section>
    </div>
  );
}
