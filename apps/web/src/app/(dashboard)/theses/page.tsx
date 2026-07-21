/**
 * /theses — flat listing of all theses with health + last-validated stamps.
 *
 * Acts as the "at-a-glance thesis health" view. Deep detail lives on
 * /positions/[ticker].
 */

import * as React from 'react';
import Link from 'next/link';
import { listOpenPositions, prisma } from '@vantage/db';
import { FrostedPanel } from '@/components/FrostedPanel';
import { ThesisLabel, type ThesisHealth } from '@/components/ThesisGlow';
import { fmtTimeAgo } from '@/lib/format';
import { PortfolioTabs } from '@/components/PortfolioTabs';
import { DbErrorBanner } from '@/components/DbErrorBanner';

export const dynamic = 'force-dynamic';

export default async function ThesesPage(): Promise<React.ReactElement> {
  let rows: Array<{
    ticker: string;
    status: ThesisHealth;
    summary: string;
    lastValidatedAt: Date | null;
    pillarCount: number;
    riskCount: number;
  }> = [];
  let dbError: string | null = null;
  try {
    const positions = await listOpenPositions();
    const theses = await prisma.thesis.findMany({
      where: { positionId: { in: positions.map((p) => p.id) } },
    });
    const byPos = new Map(theses.map((t) => [t.positionId, t]));
    rows = positions.map((p) => {
      const t = byPos.get(p.id);
      if (!t) {
        return {
          ticker: p.ticker,
          status: 'None' as ThesisHealth,
          summary: 'No thesis set.',
          lastValidatedAt: null,
          pillarCount: 0,
          riskCount: 0,
        };
      }
      const days = (Date.now() - t.lastValidatedAt.getTime()) / 86_400_000;
      const status: ThesisHealth = days > 30 ? 'Stale' : (t.status as ThesisHealth);
      const pillarCount = Array.isArray(t.pillars) ? (t.pillars as unknown[]).length : 0;
      const riskCount = Array.isArray(t.riskFactors) ? (t.riskFactors as unknown[]).length : 0;
      return {
        ticker: p.ticker,
        status,
        summary: t.summary,
        lastValidatedAt: t.lastValidatedAt,
        pillarCount,
        riskCount,
      };
    });
  } catch (err) {
    rows = [];
    dbError = err instanceof Error ? err.message : 'database unreachable';
  }

  return (
    <div className="cc-page">
      <header className="mb-6">
        <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
          theses
        </div>
        <h1 className="cc-page-title">Health</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          One row per open position — click through for full detail.
        </p>
      </header>

      <div className="mb-6">
        <PortfolioTabs />
      </div>

      <DbErrorBanner message={dbError} />

      {rows.length === 0 ? (
        <FrostedPanel padding="lg">
          <div className="text-center font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
            No theses yet.
          </div>
        </FrostedPanel>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((r) => (
            <Link key={r.ticker} href={`/positions/${r.ticker}`}>
              <FrostedPanel
                padding="md"
                className="flex h-full flex-col gap-3 transition hover:border-white/[0.18] hover:bg-white/[0.06]"
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-base font-semibold tracking-wide">
                    {r.ticker}
                  </span>
                  <ThesisLabel status={r.status} />
                </div>
                <p className="line-clamp-3 text-sm text-foreground/80">{r.summary}</p>
                <div className="mt-auto flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                  <span>
                    {r.pillarCount} pillars · {r.riskCount} risks
                  </span>
                  <span>{r.lastValidatedAt ? fmtTimeAgo(r.lastValidatedAt) : 'unvalidated'}</span>
                </div>
              </FrostedPanel>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
