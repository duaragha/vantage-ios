/**
 * /insights — chronological Insight stream.
 *
 * Server component fetches the first page; client component handles the
 * filter chips + action buttons + Framer Motion entry animations.
 */

import * as React from 'react';
import { EventKind, prisma } from '@vantage/db';
import type { Insight, MarketEvent } from '@vantage/db';
import { InsightsFeed, type InsightView } from './InsightsFeed';
import { InsightsTabs } from '@/components/InsightsTabs';
import { normalizeInsightAction } from '@/lib/insightActions';
import { DbErrorBanner } from '@/components/DbErrorBanner';
import { renderMarketEvent } from '@/lib/chatRetrieval';

export const dynamic = 'force-dynamic';

interface CatalystEventView {
  occurredAt: Date;
  details: string[];
}

function toView(
  row: Insight,
  positionTickers: ReadonlyMap<number, string>,
  catalystEvents: ReadonlyMap<string, CatalystEventView[]>,
): InsightView {
  const citations = Array.isArray(row.citations) ? (row.citations as unknown[]) : [];
  const normalizedCitations = citations
    .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
    .map((c) => ({
      articleId: typeof c['articleId'] === 'number' ? (c['articleId'] as number) : null,
      quote: typeof c['quote'] === 'string' ? (c['quote'] as string) : '',
    }));
  const baseAction = normalizeInsightAction(row.actionJson);
  const action = normalizeInsightAction(row.actionJson, {
    positionTicker:
      baseAction?.positionId !== null && baseAction?.positionId !== undefined
        ? (positionTickers.get(baseAction.positionId) ?? null)
        : null,
  });
  const catalystDetails = action?.ticker
    ? (catalystEvents.get(action.ticker.toUpperCase()) ?? [])
        .filter((event) => {
          const age = row.createdAt.getTime() - event.occurredAt.getTime();
          return age >= -6 * 60 * 60 * 1000 && age <= 72 * 60 * 60 * 1000;
        })
        .flatMap((event) => event.details)
        .slice(0, 6)
    : [];
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    reasoning: row.reasoning,
    confidence: row.confidence,
    status: row.status,
    triggeredBy: row.triggeredBy,
    createdAt: row.createdAt.toISOString(),
    citations: normalizedCitations,
    action,
    catalystDetails,
  };
}

export default async function InsightsPage(): Promise<React.ReactElement> {
  let rows: Insight[] = [];
  let dbError: string | null = null;
  const positionTickers = new Map<number, string>();
  const catalystEvents = new Map<string, CatalystEventView[]>();
  try {
    rows = await prisma.insight.findMany({
      orderBy: { createdAt: 'desc' },
      take: 40,
    });
    const positionIds = Array.from(
      new Set(
        rows
          .map((row) => normalizeInsightAction(row.actionJson)?.positionId ?? null)
          .filter((id): id is number => id !== null),
      ),
    );
    if (positionIds.length > 0) {
      const positions = await prisma.position.findMany({
        where: { id: { in: positionIds } },
        select: { id: true, ticker: true },
      });
      for (const position of positions) {
        positionTickers.set(position.id, position.ticker.toUpperCase());
      }
    }
    const actionTickers = Array.from(
      new Set(
        rows
          .map((row) => {
            const base = normalizeInsightAction(row.actionJson);
            return normalizeInsightAction(row.actionJson, {
              positionTicker:
                base?.positionId !== null && base?.positionId !== undefined
                  ? (positionTickers.get(base.positionId) ?? null)
                  : null,
            })?.ticker;
          })
          .filter((ticker): ticker is string => Boolean(ticker))
          .map((ticker) => ticker.toUpperCase()),
      ),
    );
    if (actionTickers.length > 0) {
      const events = (await prisma.marketEvent.findMany({
        where: {
          ticker: { in: actionTickers },
          kind: {
            in: [
              EventKind.InsiderCluster,
              EventKind.Earnings,
              EventKind.EarningsBeat,
              EventKind.Filing8K,
              EventKind.Material8K,
              EventKind.AnalystUpgrade,
            ],
          },
          occurredAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
        },
        orderBy: { occurredAt: 'desc' },
        select: { ticker: true, kind: true, occurredAt: true, payload: true },
      })) as Array<Pick<MarketEvent, 'ticker' | 'kind' | 'occurredAt' | 'payload'>>;
      for (const event of events) {
        if (!event.ticker) continue;
        const ticker = event.ticker.toUpperCase();
        const bucket = catalystEvents.get(ticker) ?? [];
        bucket.push({
          occurredAt: event.occurredAt,
          details: renderMarketEvent(event).map((line) =>
            line.replace(/^\d{4}-\d{2}-\d{2}\s+/, ''),
          ),
        });
        catalystEvents.set(ticker, bucket);
      }
    }
  } catch (err) {
    rows = [];
    dbError = err instanceof Error ? err.message : 'database unreachable';
  }
  const insights = rows.map((row) => toView(row, positionTickers, catalystEvents));
  return (
    <div className="cc-page">
      <header className="mb-6">
        <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
          insights
        </div>
        <h1 className="cc-page-title">Feed</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Everything the agent flagged, most recent first.
        </p>
      </header>
      <div className="mb-6">
        <InsightsTabs />
      </div>
      <DbErrorBanner message={dbError} />
      <InsightsFeed insights={insights} />
    </div>
  );
}
