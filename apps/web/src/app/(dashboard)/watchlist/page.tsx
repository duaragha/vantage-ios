/**
 * /watchlist — tickers Raghav is tracking but doesn't own.
 */

import * as React from 'react';
import { findArticlesByTicker, listWatchlist, type Article, type Watchlist } from '@vantage/db';
import { FrostedPanel } from '@/components/FrostedPanel';
import { fmtDate, fmtTimeAgo } from '@/lib/format';
import { WatchlistActions, WatchlistRowActions } from './WatchlistActions';
import { ResearchTabs } from '@/components/ResearchTabs';
import { DbErrorBanner } from '@/components/DbErrorBanner';

export const dynamic = 'force-dynamic';

interface Row {
  entry: Watchlist;
  catalystCount: number;
  latest: Article | null;
}

async function loadRows(): Promise<Row[]> {
  const entries = await listWatchlist();
  if (entries.length === 0) return [];
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const coverage = await Promise.all(
    entries.map(async (e) => {
      const articles = await findArticlesByTicker({
        ticker: e.ticker,
        since,
        limit: 5,
      });
      return {
        entry: e,
        catalystCount: articles.length,
        latest: articles[0] ?? null,
      };
    }),
  );
  return coverage;
}

export default async function WatchlistPage(): Promise<React.ReactElement> {
  let rows: Row[] = [];
  let dbError: string | null = null;
  try {
    rows = await loadRows();
  } catch (err) {
    rows = [];
    dbError = err instanceof Error ? err.message : 'database unreachable';
  }
  return (
    <div className="cc-page min-w-0">
      <header className="cc-page-header min-w-0">
        <div className="min-w-0">
          <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
            watchlist
          </div>
          <h1 className="cc-page-title">Watching</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Tickers you&rsquo;re keeping an eye on, not yet positions.
          </p>
        </div>
        <div className="cc-page-actions [&>button]:min-h-11 [&>button]:w-full [&>button]:justify-center sm:[&>button]:w-auto">
          <WatchlistActions />
        </div>
      </header>

      <div className="mb-6">
        <ResearchTabs />
      </div>

      <DbErrorBanner message={dbError} />

      <FrostedPanel padding="none" className="overflow-hidden">
        {rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-16 text-center">
            <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
              Clean slate.
            </div>
            <p className="max-w-md text-sm text-muted-foreground">
              Add a ticker to watch, news polling covers it next cycle.
            </p>
          </div>
        ) : (
          <>
            <div className="space-y-3 p-3 md:hidden">
              {rows.map((row) => (
                <article key={row.entry.id} className="cc-mobile-card min-w-0 p-4">
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-mono text-base font-semibold tabular-nums text-foreground">
                        {row.entry.ticker}
                      </div>
                      <div className="mt-1 break-words text-xs text-muted-foreground">
                        Added {fmtDate(row.entry.addedAt)} by{' '}
                        <span className="font-mono text-[10px] text-muted-foreground/70">
                          {row.entry.addedBy}
                        </span>
                      </div>
                    </div>
                    <div className="shrink-0 rounded-lg border border-white/[0.07] bg-black/15 px-3 py-2 text-right">
                      <div className="font-mono text-[9px] uppercase tracking-[0.16em] text-muted-foreground">
                        Catalysts · 14d
                      </div>
                      <div className="mt-0.5 font-mono text-lg tabular-nums text-foreground">
                        {row.catalystCount}
                      </div>
                    </div>
                  </div>

                  <div className="mt-4">
                    <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
                      Reason
                    </div>
                    <p className="mt-1 break-words text-sm leading-relaxed text-foreground/80">
                      {row.entry.reason ?? 'No reason saved.'}
                    </p>
                  </div>

                  <div className="mt-4 min-w-0 border-t border-white/[0.06] pt-3">
                    <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
                      Latest coverage
                    </div>
                    {row.latest ? (
                      <div className="mt-1 min-w-0">
                        <a
                          href={row.latest.url}
                          target="_blank"
                          rel="noreferrer"
                          className="flex min-h-11 min-w-0 items-center break-words py-1 text-xs leading-relaxed text-foreground/85 transition hover:text-[var(--cc-accent)]"
                        >
                          {row.latest.headline}
                        </a>
                        <div className="font-mono text-[10px] text-muted-foreground/60">
                          {fmtTimeAgo(row.latest.publishedAt)}
                        </div>
                      </div>
                    ) : (
                      <div className="mt-2 text-xs text-muted-foreground">No recent coverage.</div>
                    )}
                  </div>

                  <div className="mt-4 [&>div]:w-full [&_a]:inline-flex [&_a]:min-h-11 [&_a]:min-w-0 [&_a]:flex-1 [&_a]:items-center [&_a]:justify-center [&_button]:min-h-11 [&_button]:min-w-0 [&_button]:flex-1">
                    <WatchlistRowActions ticker={row.entry.ticker} />
                  </div>
                </article>
              ))}
            </div>

            <table className="hidden w-full text-sm md:table">
              <thead>
                <tr className="border-b border-white/[0.06] text-left font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                  <th className="px-4 py-3">Ticker</th>
                  <th className="px-4 py-3">Reason</th>
                  <th className="px-4 py-3">Added</th>
                  <th className="px-4 py-3 text-right">Catalysts (14d)</th>
                  <th className="px-4 py-3">Latest</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.entry.id} className="border-b border-white/[0.04]">
                    <td className="px-4 py-3 font-mono text-sm font-semibold">
                      {row.entry.ticker}
                    </td>
                    <td className="px-4 py-3 text-sm text-foreground/80">
                      {row.entry.reason ?? '-'}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {fmtDate(row.entry.addedAt)}{' '}
                      <span className="font-mono text-[10px] text-muted-foreground/60">
                        ({row.entry.addedBy})
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums">
                      {row.catalystCount}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {row.latest ? (
                        <div>
                          <a
                            href={row.latest.url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-foreground/85 transition hover:text-[var(--cc-accent)]"
                          >
                            {row.latest.headline.slice(0, 80)}
                          </a>
                          <div className="font-mono text-[10px] text-muted-foreground/60">
                            {fmtTimeAgo(row.latest.publishedAt)}
                          </div>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <WatchlistRowActions ticker={row.entry.ticker} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </FrostedPanel>
    </div>
  );
}
