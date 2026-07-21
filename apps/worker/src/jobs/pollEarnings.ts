/**
 * Poll Finnhub earnings calendar (today + next 7 days).
 *
 * For each earnings row on a held or watchlist ticker:
 *   - If reportDate == today AND epsActual != null AND no prior Earnings
 *     MarketEvent exists for (ticker, reportDate):
 *       write MarketEvent kind=Earnings with surprise/actual/estimate/revenue
 *       AND when surprisePct ≥ 10, queue a Sonnet guidance classification
 *       call. Promotes to a kind=EarningsBeat MarketEvent when the
 *       classifier says guidance ∈ {raise, hold} with confidence ≥ medium.
 *   - If reportDate > today AND we haven't seen a calendar entry yet:
 *       write a non-event Article record tagged source="finnhub_calendar"
 *       with a synthetic URL so it appears on the catalyst calendar page.
 */

import {
  DEFAULT_TIMEZONE,
  prisma,
  createMarketEvent,
  EventKind,
  startOfZonedDay,
  utcDateOnlyRange,
  zonedDateKey,
  type Prisma,
} from '@vantage/db';
import { extractEarningsGuidance } from '@vantage/llm';
import { getFinnhub } from '../lib/adapters.js';
import { buildCatalystUniverse } from '../lib/catalystUniverse.js';
import { enqueueArticleEmbedding } from './embedWorker.js';
import type { FastifyBaseLogger } from 'fastify';

export interface PollEarningsResult {
  earningsEventsFetched: number;
  actualsDetected: number;
  upcomingNew: number;
  earningsBeatsEmitted: number;
  guidanceClassificationsRun: number;
  failedSources: string[];
  tickersInScope: number;
}

const EARNINGS_GUIDANCE_DAILY_CAP = 10;

/**
 * Count today's `earnings-guidance` LlmCalls. Guards the per-day cap
 * before we spend more Sonnet tokens. The boundary follows UserSettings and
 * does not depend on the worker process timezone.
 */
async function countTodayGuidanceCalls(timezone: string): Promise<number> {
  const start = startOfZonedDay(new Date(), timezone);
  return prisma.llmCall.count({
    where: {
      purpose: 'earnings-guidance',
      createdAt: { gte: start },
    },
  });
}

/**
 * Pull tier-1/2 articles that mention `ticker` and were published in the
 * 24h window after `reportDate`. Used to feed the guidance classifier.
 */
async function loadPostEarningsArticles(
  ticker: string,
  reportDate: Date,
): Promise<
  Array<{
    id: number;
    sourceTier: number;
    source: string;
    url: string;
    headline: string;
    body: string | null;
    publishedAt: Date;
  }>
> {
  const start = reportDate;
  const end = new Date(reportDate.getTime() + 24 * 60 * 60 * 1000);
  const rows = await prisma.article.findMany({
    where: {
      tickers: { has: ticker.toUpperCase() },
      publishedAt: { gte: start, lte: end },
      sourceTier: { in: [1, 2] },
      satireBlocked: false,
    },
    select: {
      id: true,
      sourceTier: true,
      source: true,
      url: true,
      headline: true,
      body: true,
      publishedAt: true,
    },
    orderBy: { publishedAt: 'asc' },
    take: 12,
  });
  return rows;
}

function startOfDayUtc(ymd: string): Date {
  return new Date(`${ymd}T00:00:00Z`);
}

function endOfDayUtc(ymd: string): Date {
  return new Date(`${ymd}T23:59:59Z`);
}

export async function pollEarnings(
  log: FastifyBaseLogger | Console = console,
): Promise<PollEarningsResult> {
  const failed = new Set<string>();

  const universe = await buildCatalystUniverse({ limit: 200 });
  const inScope = new Set<string>(universe);
  const settings = await prisma.userSettings.findUnique({
    where: { id: 1 },
    select: { timezone: true },
  });
  const timezone = settings?.timezone || DEFAULT_TIMEZONE;
  const now = new Date();

  let events: Awaited<ReturnType<ReturnType<typeof getFinnhub>['getEarningsCalendar']>> = [];
  const todayStr = zonedDateKey(now, timezone);
  const in7 = utcDateOnlyRange(now, 0, 7, timezone).end;
  try {
    const fn = getFinnhub();
    events = await fn.getEarningsCalendar(now, in7);
  } catch (err) {
    log.warn?.(
      { err: err instanceof Error ? err.message : err },
      'finnhub earnings calendar failed',
    );
    failed.add('finnhub');
    return {
      earningsEventsFetched: 0,
      actualsDetected: 0,
      upcomingNew: 0,
      earningsBeatsEmitted: 0,
      guidanceClassificationsRun: 0,
      failedSources: [...failed],
      tickersInScope: inScope.size,
    };
  }

  let actualsDetected = 0;
  let upcomingNew = 0;
  let earningsBeatsEmitted = 0;
  let guidanceClassificationsRun = 0;
  // Count guidance calls already made today so we honor the per-day cap
  // across multiple cron ticks. Re-checked before each new call below.
  const todayUsed = await countTodayGuidanceCalls(timezone);

  for (const e of events) {
    const ticker = e.symbol?.toUpperCase();
    if (!ticker || !inScope.has(ticker)) continue;

    const reportYmd = e.date;
    if (!reportYmd) continue;

    // Actual — report happened today and we have actual EPS.
    if (reportYmd === todayStr && e.epsActual !== null) {
      // Dedup: any prior Earnings MarketEvent for (ticker, reportDate)?
      const prior = await prisma.marketEvent.findFirst({
        where: {
          kind: EventKind.Earnings,
          ticker,
          occurredAt: {
            gte: startOfDayUtc(reportYmd),
            lte: endOfDayUtc(reportYmd),
          },
        },
      });
      if (prior) continue;

      const actual = e.epsActual;
      const estimate = e.epsEstimate;
      const surprise =
        actual !== null && estimate !== null && estimate !== 0
          ? Number((((actual - estimate) / Math.abs(estimate)) * 100).toFixed(2))
          : null;
      // Compute revenue surprise pct in the same loop so the payload has
      // both deltas. Used by the catalyst engine in sub-phase B.
      const revenueActual = typeof e.revenueActual === 'number' ? e.revenueActual : null;
      const revenueEstimate = typeof e.revenueEstimate === 'number' ? e.revenueEstimate : null;
      const revenueSurprisePct =
        revenueActual !== null && revenueEstimate !== null && revenueEstimate !== 0
          ? Number(
              (((revenueActual - revenueEstimate) / Math.abs(revenueEstimate)) * 100).toFixed(2),
            )
          : null;

      await createMarketEvent({
        kind: EventKind.Earnings,
        ticker,
        occurredAt: new Date(`${reportYmd}T00:00:00Z`),
        payload: {
          ticker,
          reportDate: reportYmd,
          actual,
          estimate,
          surprise,
          revenueActual,
          revenueEstimate,
          revenueSurprisePct,
          hour: e.hour,
          quarter: e.quarter,
          year: e.year,
        },
      });
      actualsDetected++;

      // Phase 17.2 — when the EPS surprise is ≥ 10%, queue a Sonnet
      // guidance classifier and (if direction ≠ lower with confidence ≥
      // medium) emit an EarningsBeat MarketEvent.
      if (
        surprise !== null &&
        surprise >= 10 &&
        todayUsed + guidanceClassificationsRun < EARNINGS_GUIDANCE_DAILY_CAP
      ) {
        // Dedup: any prior EarningsBeat for (ticker, reportDate)?
        const priorBeat = await prisma.marketEvent.findFirst({
          where: {
            kind: EventKind.EarningsBeat,
            ticker,
            occurredAt: {
              gte: startOfDayUtc(reportYmd),
              lte: endOfDayUtc(reportYmd),
            },
          },
          select: { id: true },
        });
        if (!priorBeat) {
          const reportDate = new Date(`${reportYmd}T00:00:00Z`);
          const articles = await loadPostEarningsArticles(ticker, reportDate);
          const reportSummary = `EPS actual ${actual ?? 'n/a'} vs estimate ${estimate ?? 'n/a'} (surprise ${surprise.toFixed(1)}%). Revenue actual ${revenueActual ?? 'n/a'} vs estimate ${revenueEstimate ?? 'n/a'}. Quarter Q${e.quarter} ${e.year}.`;
          try {
            const guidance = await extractEarningsGuidance({
              ticker,
              reportSummary,
              articles,
            });
            guidanceClassificationsRun++;
            const payload = guidance.payload;
            if (
              payload &&
              guidance.quotesValid &&
              payload.direction !== 'lower' &&
              (payload.confidence === 'medium' || payload.confidence === 'high')
            ) {
              const beatPayload: Prisma.InputJsonValue = {
                ticker,
                reportDate: reportYmd,
                actual,
                estimate,
                surprise,
                revenueActual,
                revenueEstimate,
                revenueSurprisePct,
                guidanceDirection: payload.direction,
                guidanceConfidence: payload.confidence,
                materialQuotes: payload.materialQuotes,
                sourceArticleIds: articles.map((a) => a.id),
              };
              await createMarketEvent({
                kind: EventKind.EarningsBeat,
                ticker,
                occurredAt: reportDate,
                payload: beatPayload,
              });
              earningsBeatsEmitted++;
            }
          } catch (err) {
            log.warn?.(
              { ticker, err: err instanceof Error ? err.message : err },
              'pollEarnings: guidance classifier failed',
            );
          }
        }
      } else if (
        surprise !== null &&
        surprise >= 10 &&
        todayUsed + guidanceClassificationsRun >= EARNINGS_GUIDANCE_DAILY_CAP
      ) {
        log.warn?.(
          { ticker, todayUsed, runs: guidanceClassificationsRun },
          'pollEarnings: guidance daily cap hit — skipping classification',
        );
      }
      continue;
    }

    // Upcoming — synthetic Article so catalyst calendar page shows it.
    if (reportYmd > todayStr) {
      const url = `urn:finnhub:earnings:${ticker}:${reportYmd}`;
      const existing = await prisma.article.findUnique({
        where: { url },
        select: { id: true },
      });
      if (existing) continue;

      const headline = `${ticker} earnings ${reportYmd} (${e.hour || 'tbd'})`;
      const body =
        `Q${e.quarter} ${e.year} — estimate: EPS ${e.epsEstimate ?? 'n/a'}, ` +
        `revenue ${e.revenueEstimate ?? 'n/a'}.`;
      const article = await prisma.article.create({
        data: {
          sourceTier: 1,
          source: 'finnhub_calendar',
          domain: null,
          url,
          headline,
          body,
          publishedAt: new Date(`${reportYmd}T00:00:00Z`),
          tickers: [ticker],
          clusterId: null,
          trustedCitable: true,
          satireBlocked: false,
        },
      });
      upcomingNew++;
      enqueueArticleEmbedding({
        articleId: article.id,
        headline,
        body,
      });
    }
  }

  return {
    earningsEventsFetched: events.length,
    actualsDetected,
    upcomingNew,
    earningsBeatsEmitted,
    guidanceClassificationsRun,
    failedSources: [...failed],
    tickersInScope: inScope.size,
  };
}
