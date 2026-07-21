/**
 * Poll news: Finnhub company news plus approved StockTwits streams.
 *
 * For each held + watchlist ticker:
 *   Finnhub: last 1h of /company-news
 *   StockTwits: latest stream snapshot
 *
 * Each normalized article:
 *   - skip if domain is satire
 *   - classify tier + domain
 *   - compute dedup cluster key
 *   - upsert Article
 *   - enqueue for embedding
 *   - enqueue for relevance classification
 */

import { prisma } from '@vantage/db';
import {
  classifyDomain,
  clusterKey,
  exchangeFromSymbol,
  type NormalizedArticle,
} from '@vantage/sources';
import { sendSelfAlert } from '@vantage/notify';
import { getFinnhub, getStocktwits } from '../lib/adapters.js';
import { enqueueArticleEmbedding } from './embedWorker.js';
import { enqueueRelevanceCheck } from './relevanceFilter.js';
import type { FastifyBaseLogger } from 'fastify';

export interface PollNewsResult {
  articlesFetched: number;
  newArticles: number;
  duplicatesCollapsed: number;
  satireBlocked: number;
  failedSources: string[];
  disabledSources: string[];
  tickersPolled: number;
}

interface CollectArgs {
  ticker: string;
  log: FastifyBaseLogger | Console;
  sinceMs: number;
  failed: Set<string>;
  disabled: Set<string>;
}

async function collectFinnhub({
  ticker,
  log,
  sinceMs,
  failed,
}: CollectArgs): Promise<NormalizedArticle[]> {
  if (exchangeFromSymbol(ticker) !== 'US') {
    return [];
  }
  try {
    const finnhub = getFinnhub();
    const to = new Date();
    const from = new Date(Date.now() - sinceMs);
    const items = await finnhub.getCompanyNews(ticker, from, to);
    // Finnhub /company-news returns a full day regardless of range — filter to window.
    const cutoff = from.getTime();
    return items.filter((a) => a.publishedAt.getTime() >= cutoff);
  } catch (err) {
    log.warn?.(
      { ticker, err: err instanceof Error ? err.message : err },
      'finnhub news fetch failed',
    );
    failed.add('finnhub');
    return [];
  }
}

async function collectStocktwits({
  ticker,
  log,
  failed,
  disabled,
}: CollectArgs): Promise<NormalizedArticle[]> {
  const st = getStocktwits();
  if (!st) {
    disabled.add('stocktwits');
    return [];
  }
  try {
    const articles = await st.getTickerStream(ticker);
    if (st.isAccessDisabled) disabled.add('stocktwits');
    return articles;
  } catch (err) {
    log.warn?.(
      { ticker, err: err instanceof Error ? err.message : err },
      'stocktwits fetch failed',
    );
    failed.add('stocktwits');
    return [];
  }
}

export async function pollNews(
  log: FastifyBaseLogger | Console = console,
  opts: { sinceMs?: number } = {},
): Promise<PollNewsResult> {
  const sinceMs = opts.sinceMs ?? 60 * 60 * 1000; // 1h

  const [positions, watchlist] = await Promise.all([
    prisma.position.findMany({ where: { closedAt: null } }),
    prisma.watchlist.findMany(),
  ]);
  const tickers = Array.from(
    new Set(
      [...positions.map((p) => p.ticker), ...watchlist.map((w) => w.ticker)].map((t) =>
        t.toUpperCase(),
      ),
    ),
  );

  const failed = new Set<string>();
  const disabled = new Set<string>();
  const allArticles: NormalizedArticle[] = [];

  // Pull from each source for each ticker, collecting into a flat list.
  for (const ticker of tickers) {
    const args: CollectArgs = { ticker, log, sinceMs, failed, disabled };
    // Finnhub is always on. Approved StockTwits access is optional.
    const [fn, st] = await Promise.all([collectFinnhub(args), collectStocktwits(args)]);
    allArticles.push(...fn, ...st);
  }

  let satireBlocked = 0;
  let newArticles = 0;
  let duplicatesCollapsed = 0;

  // Dedup on URL within this batch first to avoid self-collisions during upsert.
  const seenUrls = new Set<string>();
  for (const a of allArticles) {
    if (seenUrls.has(a.url)) {
      duplicatesCollapsed++;
      continue;
    }
    seenUrls.add(a.url);

    const { tier, domain, isSatire } = classifyDomain(a.url);
    if (isSatire) {
      satireBlocked++;
      // Still write an Article so we can audit what was blocked, but mark it.
      await prisma.article.upsert({
        where: { url: a.url },
        create: {
          sourceTier: tier,
          source: a.source,
          domain,
          url: a.url,
          headline: a.headline,
          body: a.body,
          publishedAt: a.publishedAt,
          tickers: [],
          clusterId: null,
          trustedCitable: false,
          satireBlocked: true,
        },
        update: { satireBlocked: true, trustedCitable: false },
      });
      continue;
    }

    const primary = a.tickers[0] ?? 'UNKNOWN';
    const cid = clusterKey(a.headline, a.publishedAt, primary);

    // Detect new vs duplicate URL (we treat "already existed" as a duplicate,
    // even though the content may have been updated).
    const existing = await prisma.article.findUnique({
      where: { url: a.url },
      select: { id: true },
    });

    // Keep tickers as a sentinel "__PENDING__" until the relevance filter runs.
    // This preserves the "is this new" signal without conflating with the
    // keyword-filtered-out empty-tickers state.
    const pendingTickers = ['__PENDING__'];

    const article = await prisma.article.upsert({
      where: { url: a.url },
      create: {
        sourceTier: tier,
        source: a.source,
        domain,
        url: a.url,
        headline: a.headline,
        body: a.body,
        publishedAt: a.publishedAt,
        tickers: existing ? a.tickers : pendingTickers,
        clusterId: cid,
        trustedCitable: true,
        satireBlocked: false,
        socialSentiment: a.socialSentiment ?? null,
      },
      update: {
        sourceTier: tier,
        source: a.source,
        domain,
        headline: a.headline,
        body: a.body,
        publishedAt: a.publishedAt,
        clusterId: cid,
        socialSentiment: a.socialSentiment ?? null,
      },
    });

    if (!existing) {
      newArticles++;
      enqueueArticleEmbedding({
        articleId: article.id,
        headline: a.headline,
        body: a.body,
      });
      enqueueRelevanceCheck(article.id);
    } else {
      duplicatesCollapsed++;
    }
  }

  // If the finnhub path (the only always-on primary source) failed AND we
  // have no articles, treat this as an "all sources down" cycle. We lean on
  // sendSelfAlert's 30-min debounce to keep the warn to ~once per day in
  // practice — a single poll cycle takes <5min so consecutive failures hit
  // the same dedup bucket.
  if (tickers.length > 0 && allArticles.length === 0 && failed.has('finnhub')) {
    void sendSelfAlert('warn', 'pollNews: all primary news sources failed', {
      failedSources: [...failed],
      tickersPolled: tickers.length,
    });
  }

  return {
    articlesFetched: allArticles.length,
    newArticles,
    duplicatesCollapsed,
    satireBlocked,
    failedSources: [...failed],
    disabledSources: [...disabled],
    tickersPolled: tickers.length,
  };
}
