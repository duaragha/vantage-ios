/**
 * Market-wide news poller.
 *
 * POST /jobs/poll/marketNews, cron `*\/15 * * * 1-5`.
 *
 * Pulls Finnhub `/news?category=<category>` across a small list of categories.
 * Each article is satire-filtered, tier-classified, deduped by URL, and
 * upserted into Article. Then ticker-extract runs inline (regex + Haiku
 * fallback) and populates `tickers[]`. Finally we enqueue the article for
 * embedding.
 *
 * Volume is bounded — Finnhub /news returns ≤100 rows per category per call —
 * so we can run extraction inline without a queue.
 *
 * Intentionally DOES NOT run the per-article keyword pre-filter. That filter
 * is designed for held-ticker news where we already know the tickers; market
 * news is ticker-agnostic until extraction completes.
 */

import {
  prisma,
  upsertArticle,
  updateArticleTickers,
  type Article,
} from '@vantage/db';
import {
  classifyDomain,
  clusterKey,
  type FinnhubMarketNewsItem,
  type FinnhubNewsCategory,
} from '@vantage/sources';
import { extractTickers } from '@vantage/llm';
import { getFinnhub } from '../lib/adapters.js';
import { enqueueArticleEmbedding } from './embedWorker.js';
import type { FastifyBaseLogger } from 'fastify';

export interface PollMarketNewsOptions {
  /**
   * Override the category list. Omit for the production default (general +
   * sector feeds). Smoke tests pass a single-category list to bound API cost.
   */
  categories?: readonly FinnhubNewsCategory[];
  /**
   * Skip the Haiku fallback in extractTickers. Used by smoke scripts.
   */
  disableHaiku?: boolean;
}

export interface PollMarketNewsResult {
  articlesFetched: number;
  newArticles: number;
  duplicatesCollapsed: number;
  satireBlocked: number;
  tickersExtractedRegex: number;
  tickersExtractedHaiku: number;
  tickersExtractedNone: number;
  failedCategories: string[];
  categoriesPolled: string[];
}

// Default category set. 'general' is Finnhub's market-wide feed; the sector
// labels are passed through as `category=` which Finnhub honors for some
// and returns empty for others (we treat empties as a soft skip, not error).
const DEFAULT_CATEGORIES: readonly FinnhubNewsCategory[] = [
  'general',
  'technology',
  'energy',
  'healthcare',
  'financial',
];

async function fetchCategory(
  category: FinnhubNewsCategory,
  log: FastifyBaseLogger | Console,
  failed: Set<string>,
): Promise<FinnhubMarketNewsItem[]> {
  try {
    const fn = getFinnhub();
    const items = await fn.getGeneralNews(category);
    return items;
  } catch (err) {
    log.warn?.(
      { category, err: err instanceof Error ? err.message : err },
      'market-news fetch failed',
    );
    failed.add(String(category));
    return [];
  }
}

export async function pollMarketNews(
  log: FastifyBaseLogger | Console = console,
  opts: PollMarketNewsOptions = {},
): Promise<PollMarketNewsResult> {
  const categories = opts.categories ?? DEFAULT_CATEGORIES;
  const failed = new Set<string>();
  const allItems: FinnhubMarketNewsItem[] = [];

  for (const category of categories) {
    const items = await fetchCategory(category, log, failed);
    log.info?.(
      { category, count: items.length },
      'market-news: fetched category',
    );
    allItems.push(...items);
  }

  let satireBlocked = 0;
  let newArticles = 0;
  let duplicatesCollapsed = 0;
  let tickersExtractedRegex = 0;
  let tickersExtractedHaiku = 0;
  let tickersExtractedNone = 0;

  // Dedup the provider batch, then resolve every already-stored URL in one
  // query. The feed repeats up to 100 rows per category, so a findUnique per
  // item turned an otherwise cheap duplicate poll into hundreds of round
  // trips to Postgres.
  const seenUrls = new Set<string>();
  const uniqueItems: FinnhubMarketNewsItem[] = [];
  for (const item of allItems) {
    if (!item.url || !item.headline) continue;
    if (seenUrls.has(item.url)) {
      duplicatesCollapsed++;
      continue;
    }
    seenUrls.add(item.url);
    uniqueItems.push(item);
  }
  const existingRows = await prisma.article.findMany({
    where: { url: { in: uniqueItems.map((item) => item.url) } },
    select: { url: true },
  });
  const existingUrls = new Set(existingRows.map((row) => row.url));

  for (const item of uniqueItems) {
    if (existingUrls.has(item.url)) {
      duplicatesCollapsed++;
      continue;
    }

    const { tier, domain, isSatire } = classifyDomain(item.url);

    if (isSatire) {
      satireBlocked++;
      await upsertArticle({
        sourceTier: tier,
        source: 'finnhub',
        domain,
        url: item.url,
        headline: item.headline,
        body: item.summary || null,
        publishedAt: new Date(item.datetime * 1000),
        tickers: [],
        clusterId: null,
        trustedCitable: false,
        satireBlocked: true,
      });
      continue;
    }

    const publishedAt = new Date(item.datetime * 1000);
    const cid = clusterKey(item.headline, publishedAt, 'MARKET');

    // Writing with tickers=[] initially — the extraction step below fills them.
    let article: Article;
    try {
      article = await upsertArticle({
        sourceTier: tier,
        source: 'finnhub',
        domain,
        url: item.url,
        headline: item.headline,
        body: item.summary || null,
        publishedAt,
        tickers: [],
        clusterId: cid,
        trustedCitable: true,
        satireBlocked: false,
      });
    } catch (err) {
      log.warn?.(
        { url: item.url, err: err instanceof Error ? err.message : err },
        'market-news: upsert failed',
      );
      continue;
    }

    newArticles++;

    // --- Inline ticker extraction --------------------------------------
    try {
      const extract = await extractTickers(
        {
          headline: article.headline,
          body: article.body,
          sourceTier: article.sourceTier,
        },
        { disableHaiku: opts.disableHaiku === true },
      );
      if (extract.tickers.length > 0) {
        await updateArticleTickers(article.id, extract.tickers);
      }
      switch (extract.method) {
        case 'regex':
          tickersExtractedRegex++;
          break;
        case 'haiku':
          tickersExtractedHaiku++;
          break;
        case 'none':
          tickersExtractedNone++;
          break;
      }
    } catch (err) {
      log.warn?.(
        { articleId: article.id, err: err instanceof Error ? err.message : err },
        'market-news: ticker extraction failed',
      );
      tickersExtractedNone++;
    }

    // --- Embed ----------------------------------------------------------
    enqueueArticleEmbedding({
      articleId: article.id,
      headline: article.headline,
      body: article.body,
    });
  }

  const result: PollMarketNewsResult = {
    articlesFetched: allItems.length,
    newArticles,
    duplicatesCollapsed,
    satireBlocked,
    tickersExtractedRegex,
    tickersExtractedHaiku,
    tickersExtractedNone,
    failedCategories: [...failed],
    categoriesPolled: categories.map(String),
  };
  log.info?.(result, 'poll.marketNews: done');
  return result;
}
