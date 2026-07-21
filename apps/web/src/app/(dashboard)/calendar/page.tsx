/**
 * /calendar — catalyst calendar for the next 14 days.
 *
 * Pulls MarketEvent rows with occurredAt within the window + earnings-looking
 * Articles. We don't try to magically dedup; a catalyst shows up wherever it
 * lives in the data.
 */

import * as React from 'react';
import {
  addZonedDays,
  DEFAULT_TIMEZONE,
  prisma,
  startOfZonedDay,
  utcDateOnlyRange,
  zonedDateKey,
} from '@vantage/db';
import type { MarketEvent, Article } from '@vantage/db';
import { FrostedPanel } from '@/components/FrostedPanel';
import { cn } from '@/lib/utils';
import { InsightsTabs } from '@/components/InsightsTabs';
import { DbErrorBanner } from '@/components/DbErrorBanner';
import { calendarArticleDateKey, calendarEventDateKey } from '@/lib/calendarDates';

export const dynamic = 'force-dynamic';

interface DayBucket {
  dateKey: string;
  dateIso: string;
  events: MarketEvent[];
  articles: Article[];
}

function buildWindow(timezone: string = DEFAULT_TIMEZONE): DayBucket[] {
  const start = startOfZonedDay(new Date(), timezone);
  return Array.from({ length: 14 }, (_, i) => {
    const d = addZonedDays(start, i, timezone);
    return {
      dateKey: zonedDateKey(d, timezone),
      dateIso: d.toISOString(),
      events: [],
      articles: [],
    };
  });
}

async function loadCalendar(): Promise<{ buckets: DayBucket[]; timezone: string }> {
  const settings = await prisma.userSettings.findUnique({
    where: { id: 1 },
    select: { timezone: true },
  });
  const timezone = settings?.timezone || DEFAULT_TIMEZONE;
  const buckets = buildWindow(timezone);
  const timestampStart = new Date(buckets[0]!.dateIso);
  const timestampEnd = addZonedDays(new Date(buckets[buckets.length - 1]!.dateIso), 1, timezone);
  const dateOnlyRange = utcDateOnlyRange(timestampStart, 0, buckets.length, timezone);
  const queryStart = new Date(Math.min(timestampStart.getTime(), dateOnlyRange.start.getTime()));
  const queryEnd = new Date(Math.max(timestampEnd.getTime(), dateOnlyRange.end.getTime()));

  const [events, articles] = await Promise.all([
    prisma.marketEvent.findMany({
      where: {
        occurredAt: { gte: queryStart, lt: queryEnd },
        // Calendar shows SCHEDULED upcoming catalysts only — earnings dates,
        // 8-K filings, macro releases, sector news. IntradayMove +
        // SentimentSpike + BreakingNews are reactive events that already
        // happened, they belong on /insights, not the calendar.
        kind: { in: ['Earnings', 'Filing8K', 'Macro', 'SectorNews'] },
      },
      orderBy: { occurredAt: 'asc' },
    }),
    // Earnings calendar notes pull through as Articles too.
    prisma.article.findMany({
      where: {
        source: { in: ['finnhub_calendar', 'finnhub-earnings'] },
        publishedAt: { gte: dateOnlyRange.start, lt: dateOnlyRange.end },
      },
      orderBy: { publishedAt: 'asc' },
      take: 200,
    }),
  ]);

  const byDay = new Map(buckets.map((b) => [b.dateKey, b]));
  for (const e of events) {
    const key = calendarEventDateKey(e.kind, e.occurredAt, timezone);
    byDay.get(key)?.events.push(e);
  }
  for (const a of articles) {
    const key = calendarArticleDateKey(a.publishedAt);
    byDay.get(key)?.articles.push(a);
  }
  return { buckets, timezone };
}

const KIND_COLOR: Record<string, string> = {
  Earnings: 'border-amber-500/40 bg-amber-500/10 text-amber-200',
  Filing8K: 'border-blue-500/40 bg-blue-500/10 text-blue-200',
  BreakingNews: 'border-rose-500/40 bg-rose-500/10 text-rose-200',
  IntradayMove: 'border-[var(--cc-accent)]/40 bg-[var(--cc-accent)]/10 text-[var(--cc-accent)]',
  SectorNews: 'border-violet-500/40 bg-violet-500/10 text-violet-200',
  Macro: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200',
  SentimentSpike: 'border-pink-500/40 bg-pink-500/10 text-pink-200',
};

export default async function CalendarPage(): Promise<React.ReactElement> {
  let buckets: DayBucket[] = [];
  let timezone = DEFAULT_TIMEZONE;
  let dbError: string | null = null;
  try {
    const loaded = await loadCalendar();
    buckets = loaded.buckets;
    timezone = loaded.timezone;
  } catch (err) {
    buckets = buildWindow(timezone);
    dbError = err instanceof Error ? err.message : 'database unreachable';
  }
  const today = zonedDateKey(new Date(), timezone);

  return (
    <div className="cc-page">
      <header className="mb-6">
        <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
          catalyst calendar
        </div>
        <h1 className="cc-page-title">Next 14 days</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Earnings, 8-Ks, macro releases, and news from ingested sources.
        </p>
      </header>

      <div className="mb-6">
        <InsightsTabs />
      </div>

      <DbErrorBanner message={dbError} />

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {buckets.map((b) => {
          const d = new Date(b.dateIso);
          const isToday = b.dateKey === today;
          const empty = b.events.length + b.articles.length === 0;
          return (
            <FrostedPanel
              key={b.dateKey}
              padding="md"
              className={cn(
                'flex flex-col gap-3',
                isToday && 'border-[var(--cc-accent)]/30 bg-[var(--cc-accent)]/5',
              )}
            >
              <div className="flex items-baseline justify-between">
                <div>
                  <div className="font-mono text-2xl font-semibold tabular-nums">
                    {d.toLocaleDateString('en-CA', { day: '2-digit', timeZone: timezone })}
                  </div>
                  <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                    {d.toLocaleDateString('en-CA', {
                      weekday: 'short',
                      month: 'short',
                      timeZone: timezone,
                    })}
                  </div>
                </div>
                {isToday && (
                  <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--cc-accent)]">
                    today
                  </span>
                )}
              </div>

              {empty ? (
                <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground/60">
                  nothing scheduled
                </div>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {b.events.map((e) => (
                    <li key={`evt-${e.id}`}>
                      <span
                        className={cn(
                          'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.15em]',
                          KIND_COLOR[e.kind] ??
                            'border-white/[0.1] bg-white/[0.03] text-muted-foreground',
                        )}
                      >
                        {e.kind}
                      </span>
                      <span className="ml-2 text-xs text-foreground/80">
                        {e.ticker ?? 'market'}
                      </span>
                    </li>
                  ))}
                  {b.articles.slice(0, 3).map((a) => (
                    <li key={`art-${a.id}`} className="text-xs">
                      <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.15em] text-amber-200">
                        Earn
                      </span>
                      <span className="ml-2 text-foreground/80">
                        {a.tickers.join(', ') || a.headline.slice(0, 40)}
                      </span>
                    </li>
                  ))}
                  {b.articles.length > 3 && (
                    <li className="font-mono text-[10px] text-muted-foreground/60">
                      + {b.articles.length - 3} more
                    </li>
                  )}
                </ul>
              )}
            </FrostedPanel>
          );
        })}
      </div>
    </div>
  );
}
