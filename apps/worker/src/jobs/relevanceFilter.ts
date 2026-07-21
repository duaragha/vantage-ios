/**
 * Haiku relevance filter queue.
 *
 * Flow:
 *   1. Ingest handlers enqueue a freshly-upserted Article id here.
 *   2. Queue fetches the article + current held/watchlist tickers.
 *   3. Keyword pre-filter (hasTickerMention) runs first. If no match,
 *      Article.tickers is set to [] and we stop — no LLM call.
 *   4. If at least one ticker keyword matched, Haiku 4.5 classifies via tool
 *      call: materially_relevant[] + likely_satire.
 *   5. Final Article.tickers = intersect(matched symbols, materially_relevant).
 *      Article.satireBlocked = likely_satire. If satire, trustedCitable=false.
 *
 * Concurrency: capped at 2 so we don't rip through the Haiku rate limit.
 *
 * A similar 30s sweep re-queues articles whose tickers are [] and fetchedAt is
 * recent — catches items the adapters wrote outside the hot path. We skip
 * anything already processed (tickers non-empty OR satireBlocked=true).
 */

import PQueue from 'p-queue';
import type Anthropic from '@anthropic-ai/sdk';
import { prisma, listOpenPositions, listWatchlist } from '@vantage/db';
import { callClaude, HAIKU_MODEL, hasTickerMention, type TickerSpec } from '@vantage/llm';
import type { FastifyBaseLogger } from 'fastify';
import { AdaptiveInterval } from '../lib/adaptiveInterval.js';

const queue = new PQueue({ concurrency: 2 });
const enqueued = new Set<number>();
let log: FastifyBaseLogger | Console = console;
let tickTimer: NodeJS.Timeout | null = null;
let sweepInterval: AdaptiveInterval | null = null;
/** Idle sweeps double the cadence up to this ceiling (crash-recovery only). */
const SWEEP_MAX_MS = 5 * 60_000;
let tickerSpecCache: { tickers: TickerSpec[]; fetchedAt: number } | null = null;
const TICKER_CACHE_TTL_MS = 60_000;

export function setRelevanceFilterLogger(l: FastifyBaseLogger | Console): void {
  log = l;
}

/** Build the TickerSpec list from held + watchlist tickers. Cached 60s. */
export async function getTickerSpecs(): Promise<TickerSpec[]> {
  if (tickerSpecCache && Date.now() - tickerSpecCache.fetchedAt < TICKER_CACHE_TTL_MS) {
    return tickerSpecCache.tickers;
  }
  const [positions, watchlist] = await Promise.all([listOpenPositions(), listWatchlist()]);
  const symbols = new Set<string>();
  for (const p of positions) symbols.add(p.ticker.toUpperCase());
  for (const w of watchlist) symbols.add(w.ticker.toUpperCase());
  const tickers: TickerSpec[] = [];
  for (const s of symbols) tickers.push({ symbol: s });
  tickerSpecCache = { tickers, fetchedAt: Date.now() };
  return tickers;
}

/** Flush the ticker cache (call after Position/Watchlist CRUD). */
export function invalidateTickerCache(): void {
  tickerSpecCache = null;
}

const CLASSIFY_TOOL: Anthropic.Tool = {
  name: 'classify_article',
  description:
    "Classify an article's relevance to the provided tickers. Return only ticker symbols that are materially discussed (not one-word mentions). Mark likely_satire=true for any satire/parody/obvious-joke content.",
  input_schema: {
    type: 'object',
    properties: {
      materially_relevant: {
        type: 'array',
        items: { type: 'string' },
        description: 'Subset of the candidate tickers that the article materially discusses.',
      },
      likely_satire: {
        type: 'boolean',
        description: 'True if the article is satire/parody/joke content, not real news.',
      },
    },
    required: ['materially_relevant', 'likely_satire'],
    additionalProperties: false,
  },
};

async function classifyWithHaiku(
  articleId: number,
  headline: string,
  body: string | null,
  candidates: string[],
): Promise<{ materiallyRelevant: string[]; likelySatire: boolean } | null> {
  const bodyTrim = (body ?? '').slice(0, 2000);
  const system =
    'You are a classifier. Decide which of the candidate tickers are MATERIALLY discussed in the article (not incidental mentions). Also judge whether the article is satire/parody/obvious-joke content. Respond via the classify_article tool call only — never free text.';
  const userText =
    `Candidate tickers: ${candidates.join(', ')}\n\n` +
    `Headline: ${headline}\n\n` +
    (bodyTrim ? `Body:\n${bodyTrim}` : '(No body provided.)');

  try {
    const { toolCalls, response } = await callClaude({
      model: HAIKU_MODEL,
      system,
      messages: [{ role: 'user', content: userText }],
      tools: [CLASSIFY_TOOL],
      tool_choice: { type: 'tool', name: 'classify_article' },
      maxTokens: 512,
      purpose: 'relevance-filter',
    });

    // classify_article isn't one of our emit_* structured tools, so toolCalls
    // won't parse it. Walk the raw response content instead.
    void toolCalls;
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      if (block.name !== 'classify_article') continue;
      const input = block.input as Record<string, unknown>;
      const materially = Array.isArray(input['materially_relevant'])
        ? (input['materially_relevant'] as unknown[]).filter(
            (s): s is string => typeof s === 'string',
          )
        : [];
      const satire =
        typeof input['likely_satire'] === 'boolean' ? (input['likely_satire'] as boolean) : false;
      return { materiallyRelevant: materially, likelySatire: satire };
    }
    return null;
  } catch (err) {
    log.warn?.(
      { articleId, err: err instanceof Error ? err.message : err },
      'Haiku classify failed — leaving article in matched-keyword state',
    );
    return null;
  }
}

async function processArticle(articleId: number): Promise<void> {
  const article = await prisma.article.findUnique({ where: { id: articleId } });
  if (!article) return;
  if (article.satireBlocked) return;
  // If already tickers-set by a prior pass, skip.
  if (article.tickers.length > 0 && article.tickers[0] !== '__PENDING__') {
    return;
  }

  const tickers = await getTickerSpecs();
  if (tickers.length === 0) {
    // No held/watched tickers — nothing to match against.
    await prisma.article.update({
      where: { id: articleId },
      data: { tickers: [] },
    });
    return;
  }

  const haystack = `${article.headline}\n\n${article.body ?? ''}`;
  const matched = hasTickerMention(haystack, tickers);

  if (matched.length === 0) {
    await prisma.article.update({
      where: { id: articleId },
      data: { tickers: [] },
    });
    return;
  }

  // Tier-3 social (StockTwits) is keyword-scoped by construction and never
  // citable, so the Haiku relevance/satire pass adds nothing — skip it (this was
  // ~96% of LLM spend) and keep the keyword-matched tickers. Sentiment for these
  // comes from the post's native bull/bear tag, not this classifier.
  if (article.sourceTier === 3) {
    await prisma.article.update({
      where: { id: articleId },
      data: { tickers: matched, satireBlocked: false },
    });
    return;
  }

  const classified = await classifyWithHaiku(articleId, article.headline, article.body, matched);

  if (!classified) {
    // Haiku failed; keep the keyword-matched list so we don't drop the signal.
    await prisma.article.update({
      where: { id: articleId },
      data: { tickers: matched },
    });
    return;
  }

  const relevant = new Set(classified.materiallyRelevant.map((s) => s.toUpperCase()));
  const finalTickers = matched.filter((t) => relevant.has(t.toUpperCase()));
  const isSatire = classified.likelySatire;

  await prisma.article.update({
    where: { id: articleId },
    data: {
      tickers: finalTickers,
      satireBlocked: isSatire,
      ...(isSatire ? { trustedCitable: false } : {}),
    },
  });
}

export function enqueueRelevanceCheck(articleId: number): void {
  if (enqueued.has(articleId)) return;
  enqueued.add(articleId);
  // Work is flowing again — snap the recovery sweep back to its base cadence.
  sweepInterval?.reset();
  void queue.add(async () => {
    try {
      await processArticle(articleId);
    } catch (err) {
      log.error?.(
        { articleId, err: err instanceof Error ? err.message : err },
        'relevance filter task failed',
      );
    } finally {
      enqueued.delete(articleId);
    }
  });
}

/**
 * Sweep: pick up recently-fetched articles where tickers is the "__PENDING__"
 * sentinel or was ingested just now without being enqueued (crash recovery).
 * We use a sentinel marker so we can distinguish "keyword-filtered-out with
 * empty tickers" from "not yet classified".
 */
async function sweepPending(batchSize = 50): Promise<number> {
  // Articles with the sentinel marker we inserted during ingestion.
  const rows = await prisma.article.findMany({
    where: {
      tickers: { has: '__PENDING__' },
      satireBlocked: false,
    },
    orderBy: { id: 'desc' },
    take: batchSize,
    select: { id: true },
  });
  let enq = 0;
  for (const r of rows) {
    if (!enqueued.has(r.id)) {
      enqueueRelevanceCheck(r.id);
      enq++;
    }
  }
  return enq;
}

export function startRelevanceFilter(logger?: FastifyBaseLogger | Console, tickMs = 30_000): void {
  if (logger) log = logger;
  if (tickTimer) return;
  // Adaptive cadence: base while work is flowing, doubling to SWEEP_MAX_MS
  // while idle. The sweep is crash recovery only — the hot path enqueues
  // directly (and resets the cadence), so backing off costs nothing.
  const interval = new AdaptiveInterval(tickMs, Math.max(tickMs, SWEEP_MAX_MS));
  sweepInterval = interval;
  const tick = (): void => {
    void sweepPending()
      .then((enq) => {
        interval.observe(enq > 0);
      })
      .catch((err: unknown) => {
        interval.observe(false);
        log.error?.(
          { err: err instanceof Error ? err.message : err },
          'relevance filter sweep failed',
        );
      })
      .finally(() => {
        if (!tickTimer) return;
        tickTimer = setTimeout(tick, interval.currentMs);
        tickTimer.unref?.();
      });
  };
  tickTimer = setTimeout(tick, interval.currentMs);
  tickTimer.unref?.();
  log.info?.({ tickMs, maxMs: Math.max(tickMs, SWEEP_MAX_MS) }, 'relevanceFilter started');
}

export function stopRelevanceFilter(): void {
  if (tickTimer) {
    clearTimeout(tickTimer);
    tickTimer = null;
  }
  sweepInterval = null;
}

export function relevanceQueueSize(): number {
  return queue.size + queue.pending;
}

export async function drainRelevanceQueue(): Promise<void> {
  await queue.onIdle();
}
