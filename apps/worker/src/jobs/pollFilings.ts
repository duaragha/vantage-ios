/**
 * Poll SEC EDGAR filings for held tickers.
 *
 * For each held ticker:
 *   - resolve ticker → CIK via adapter (cached inside adapter)
 *   - poll 8-K, 10-Q, 10-K feeds
 *   - for each filing not seen (accession number NOT already in Article.url):
 *       write Article (tier 1, source="edgar")
 *       if form is 8-K, also write MarketEvent kind=Filing8K
 *       Phase 17.3: fetch the filing primary doc text into Article.body and
 *         queue a Sonnet 8-K classifier (capped at 5/day). Promotes to a
 *         Material8K MarketEvent when materialityScore ≥ 7 AND
 *         marketDirection ≠ 'bearish' AND citations validate.
 *       queue for embedding
 *       (no relevance filter — 8-Ks for held tickers are always relevant)
 */

import { prisma, createMarketEvent, EventKind, startOfZonedDay, type Prisma } from '@vantage/db';
import { isCaExchange, exchangeFromSymbol } from '@vantage/sources';
import type { EdgarFiling, EdgarFormType } from '@vantage/sources';
import { classifyEightK } from '@vantage/llm';
import { getEdgar } from '../lib/adapters.js';
import { buildCatalystUniverse } from '../lib/catalystUniverse.js';
import { includeQuarterlyFilingForms } from '../lib/pollCadence.js';
import { enqueueArticleEmbedding } from './embedWorker.js';
import type { FastifyBaseLogger } from 'fastify';

export interface PollFilingsResult {
  tickersPolled: number;
  ciksBackfilled: number;
  missingCikCount: number;
  filingsFetched: number;
  newFilings: number;
  eightKsDetected: number;
  eightKClassificationsRun: number;
  material8KsEmitted: number;
  failedTickers: string[];
}

const FORMS: readonly EdgarFormType[] = ['8-K', '10-Q', '10-K'];
/** 8-K needs 5-minute latency (catalysts); quarterlies poll on the hour. */
const FAST_FORMS: readonly EdgarFormType[] = ['8-K'];

/** Hard cap per spec 17.3: max 5 8-K classifications/day. */
const EIGHT_K_DAILY_CAP = 5;
const MISSING_CIK_LOG_INTERVAL_MS = 6 * 60 * 60 * 1000;
let lastMissingCikLogAt = 0;

function normalizeCik(value: string | null | undefined): string | null {
  if (!value) return null;
  const numeric = Number(value.replace(/^0+/, '') || '0');
  if (!Number.isInteger(numeric) || numeric <= 0) return null;
  return String(numeric).padStart(10, '0');
}

async function countToday8KClassifyCalls(): Promise<number> {
  const start = startOfZonedDay();
  return prisma.llmCall.count({
    where: {
      purpose: '8k-classify',
      createdAt: { gte: start },
    },
  });
}

/**
 * Pull tier-1/2 articles published within 24h of `filedAt` for `ticker` —
 * used as corroborating context for the 8-K classifier.
 */
async function loadCorroboratingArticles(
  ticker: string,
  filedAt: Date,
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
  const start = new Date(filedAt.getTime() - 12 * 60 * 60 * 1000);
  const end = new Date(filedAt.getTime() + 24 * 60 * 60 * 1000);
  return prisma.article.findMany({
    where: {
      tickers: { has: ticker.toUpperCase() },
      publishedAt: { gte: start, lte: end },
      sourceTier: { in: [1, 2] },
      source: { not: 'edgar' },
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
    take: 8,
  });
}

export async function pollFilings(
  log: FastifyBaseLogger | Console = console,
): Promise<PollFilingsResult> {
  const edgar = getEdgar();
  // 10-Q/10-K move on quarterly timescales — polling them per 5-minute tick
  // tripled the EDGAR request volume for zero latency benefit. The top-of-
  // hour tick still covers all three forms.
  const forms = includeQuarterlyFilingForms(new Date()) ? FORMS : FAST_FORMS;
  const tickers = await buildCatalystUniverse({ limit: 200 });
  const universeRows = await prisma.tickerUniverse.findMany({
    where: { symbol: { in: tickers } },
    select: { symbol: true, name: true, cik: true },
  });
  const universeByTicker = new Map(universeRows.map((row) => [row.symbol.toUpperCase(), row]));

  let filingsFetched = 0;
  let newFilings = 0;
  let eightKsDetected = 0;
  let eightKClassificationsRun = 0;
  let material8KsEmitted = 0;
  let ciksBackfilled = 0;
  const failed: string[] = [];
  const missingCiks: string[] = [];

  const todayUsed = await countToday8KClassifyCalls();
  const remainingClassifyBudget = Math.max(0, EIGHT_K_DAILY_CAP - todayUsed);

  for (const ticker of tickers) {
    try {
      if (isCaExchange(exchangeFromSymbol(ticker))) {
        log.debug?.({ ticker }, 'pollFilings: skipping non-US ticker');
        continue;
      }
      const universeRow = universeByTicker.get(ticker);
      let cik = normalizeCik(universeRow?.cik);
      if (!cik) {
        cik = await edgar.getCikForTicker(ticker);
        if (cik && universeRow) {
          await prisma.tickerUniverse.update({
            where: { symbol: ticker },
            data: { cik: String(Number(cik)) },
          });
          ciksBackfilled += 1;
        }
      }
      if (!cik) {
        missingCiks.push(ticker);
        continue;
      }
      const allFilings: EdgarFiling[] = [];
      for (const form of forms) {
        const filings = await edgar.pollFilings(cik, form, 10);
        for (const filing of filings) {
          filing.ticker = ticker;
          if (!filing.companyName && universeRow?.name) {
            filing.companyName = universeRow.name;
          }
          allFilings.push(filing);
        }
      }
      filingsFetched += allFilings.length;

      for (const filing of allFilings) {
        // Dedup by URL (Article.url unique).
        const existing = await prisma.article.findUnique({
          where: { url: filing.url },
          select: { id: true },
        });
        if (existing) continue;

        const headline = `${filing.ticker} ${filing.formType}: ${filing.title}`;

        // Held ticker → tickers gets the symbol directly; skip relevance filter.
        const article = await prisma.article.create({
          data: {
            sourceTier: 1,
            source: 'edgar',
            domain: 'sec.gov',
            url: filing.url,
            headline,
            body: null,
            publishedAt: filing.filedAt,
            tickers: [filing.ticker],
            clusterId: filing.accessionNumber ?? null,
            trustedCitable: true,
            satireBlocked: false,
          },
        });
        newFilings++;
        enqueueArticleEmbedding({
          articleId: article.id,
          headline,
          body: null,
        });

        if (filing.formType === '8-K') {
          eightKsDetected++;
          await createMarketEvent({
            kind: EventKind.Filing8K,
            ticker: filing.ticker,
            occurredAt: filing.filedAt,
            payload: {
              formType: filing.formType,
              companyName: filing.companyName,
              url: filing.url,
              accessionNumber: filing.accessionNumber,
              cik: filing.cik,
              articleId: article.id,
            },
          });

          // Phase 17.3 — fetch primary doc text + run Sonnet classifier
          // when within the daily budget. Promote to Material8K when the
          // classification clears the materiality + citation gates.
          const remaining = remainingClassifyBudget - eightKClassificationsRun;
          if (remaining > 0) {
            try {
              const body = await edgar.fetchFilingPrimaryText(filing.url);
              if (body) {
                await prisma.article.update({
                  where: { id: article.id },
                  data: { body },
                });
              }
              const corroborators = await loadCorroboratingArticles(filing.ticker, filing.filedAt);
              const classifierInput = {
                ticker: filing.ticker,
                filing: {
                  id: article.id,
                  sourceTier: 1,
                  source: 'edgar',
                  url: filing.url,
                  headline,
                  body: body ?? null,
                  publishedAt: filing.filedAt,
                },
                newsArticles: corroborators,
              };
              const classified = await classifyEightK(classifierInput);
              eightKClassificationsRun++;
              const payload = classified.payload;
              if (
                payload &&
                classified.citationOk &&
                payload.materialityScore >= 7 &&
                payload.marketDirection !== 'bearish'
              ) {
                // Dedup by ticker + filingDate-day + category.
                const dayStart = new Date(filing.filedAt);
                dayStart.setUTCHours(0, 0, 0, 0);
                const dayEnd = new Date(dayStart);
                dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
                const priorMat = await prisma.marketEvent.findFirst({
                  where: {
                    kind: EventKind.Material8K,
                    ticker: filing.ticker,
                    occurredAt: { gte: dayStart, lt: dayEnd },
                    payload: {
                      path: ['category'],
                      equals: payload.category,
                    },
                  },
                  select: { id: true },
                });
                if (!priorMat) {
                  const matPayload: Prisma.InputJsonValue = {
                    items: payload.items,
                    category: payload.category,
                    materialityScore: payload.materialityScore,
                    summary: payload.summary,
                    marketDirection: payload.marketDirection,
                    filingUrl: filing.url,
                    filingArticleId: article.id,
                    accessionNumber: filing.accessionNumber,
                    citations: payload.citations.map((c) => ({
                      articleId: c.articleId,
                      quote: c.quote,
                    })),
                  };
                  await createMarketEvent({
                    kind: EventKind.Material8K,
                    ticker: filing.ticker,
                    occurredAt: filing.filedAt,
                    payload: matPayload,
                  });
                  material8KsEmitted++;
                }
              }
            } catch (err) {
              log.warn?.(
                {
                  ticker: filing.ticker,
                  err: err instanceof Error ? err.message : err,
                },
                'pollFilings: 8-K classifier failed',
              );
            }
          } else {
            log.warn?.(
              {
                ticker: filing.ticker,
                todayUsed,
                runs: eightKClassificationsRun,
              },
              'pollFilings: 8-K classify daily cap hit — skipping',
            );
          }
        }
      }
    } catch (err) {
      log.warn?.(
        { ticker, err: err instanceof Error ? err.message : err },
        'edgar poll failed for ticker',
      );
      failed.push(ticker);
    }
  }

  if (missingCiks.length > 0 && Date.now() - lastMissingCikLogAt >= MISSING_CIK_LOG_INTERVAL_MS) {
    lastMissingCikLogAt = Date.now();
    log.warn?.(
      {
        count: missingCiks.length,
        sample: missingCiks.slice(0, 12),
      },
      'edgar: catalyst tickers absent from current SEC CIK map',
    );
  }

  return {
    tickersPolled: tickers.length,
    ciksBackfilled,
    missingCikCount: missingCiks.length,
    filingsFetched,
    newFilings,
    eightKsDetected,
    eightKClassificationsRun,
    material8KsEmitted,
    failedTickers: failed,
  };
}
