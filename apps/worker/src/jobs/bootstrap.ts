/**
 * Cold-start / bootstrap job.
 *
 *   POST /jobs/bootstrap/:ticker
 *
 * Steps (spec ### Cold-start / bootstrap + Phase 9 task brief):
 *   1. Verify a Position OR Watchlist entry exists for the ticker. If the
 *      ticker isn't tracked, refuse — we don't want to burn LLM tokens on
 *      arbitrary symbols.
 *   2. Finnhub news last 30d → Article rows. Enqueue embedding + enqueue
 *      relevance filter for each new row.
 *   3. EDGAR filings last 2 quarters (10-K, 10-Q, 8-K) → Article rows,
 *      MarketEvent kind=Filing8K for any 8-Ks. Idempotent on filing URL.
 *   4. Finnhub earnings calendar: last 4 reported + upcoming inside our
 *      lookback. Synthesize catalyst-calendar Articles for upcoming reports.
 *   5. If the Position has no Thesis yet: call Sonnet with `emit_initial_thesis`
 *      to synthesize one (summary + pillars + risk factors) from the ingested
 *      context, and upsert.
 *   6. If a Thesis exists: run evaluateThesis(positionId) with a 30-day window
 *      so the baseline eval attributes every relevant article to pillars.
 *   7. Return summary.
 *
 * Idempotency:
 *   - Article.upsert on url ⇒ re-running does not duplicate rows.
 *   - MarketEvent is created once per new 8-K by Article-url dedup above.
 *   - Thesis upsert keys on positionId (one thesis per position).
 */

import {
  prisma,
  createMarketEvent,
  EventKind,
  upsertThesis,
  type Position,
  type Thesis,
  type Prisma,
} from '@vantage/db';
import {
  callClaude,
  SONNET_MODEL,
  buildSystemPrompt,
  EMIT_INITIAL_THESIS_TOOL,
  parseInitialThesis,
  type ParsedToolCall,
  type InitialThesisPayload,
} from '@vantage/llm';
import { evaluateThesis } from '@vantage/core';
import { classifyDomain } from '@vantage/sources';
import { getFinnhub, getEdgar } from '../lib/adapters.js';
import { easternDateKey } from '../lib/marketTime.js';
import { enqueueArticleEmbedding } from './embedWorker.js';
import { enqueueRelevanceCheck } from './relevanceFilter.js';
import type { FastifyBaseLogger } from 'fastify';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BootstrapTickerResult {
  ticker: string;
  /** true if the ticker is on a Position (false ⇒ only Watchlist). */
  heldPosition: boolean;
  articlesFetched: number;
  articlesNew: number;
  filingsFetched: number;
  filingsNew: number;
  eightKsDetected: number;
  earningsFetched: number;
  earningsNewActuals: number;
  earningsUpcomingWritten: number;
  thesisInitialized: boolean;
  thesisEvaluated: boolean;
  evaluationId: number | null;
  note?: string;
}

export interface BootstrapOptions {
  log?: FastifyBaseLogger | Console;
  /** Days of news lookback. Default 30. */
  newsLookbackDays?: number;
  /** Days of filings lookback. Default ~180 (2 quarters). */
  filingsLookbackDays?: number;
  /** Fire Telegram on status change during the baseline eval. Default false. */
  sendTelegram?: boolean;
}

const DEFAULT_NEWS_DAYS = 30;
const DEFAULT_FILINGS_DAYS = 180;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function bootstrapTicker(
  tickerRaw: string,
  opts: BootstrapOptions = {},
): Promise<BootstrapTickerResult> {
  const log = opts.log ?? console;
  const ticker = tickerRaw.trim().toUpperCase();
  if (!ticker) throw new Error('bootstrapTicker: ticker is empty');

  const newsDays = opts.newsLookbackDays ?? DEFAULT_NEWS_DAYS;
  const filingsDays = opts.filingsLookbackDays ?? DEFAULT_FILINGS_DAYS;

  const result: BootstrapTickerResult = {
    ticker,
    heldPosition: false,
    articlesFetched: 0,
    articlesNew: 0,
    filingsFetched: 0,
    filingsNew: 0,
    eightKsDetected: 0,
    earningsFetched: 0,
    earningsNewActuals: 0,
    earningsUpcomingWritten: 0,
    thesisInitialized: false,
    thesisEvaluated: false,
    evaluationId: null,
  };

  // --- Step 1: verify the ticker is tracked -----------------------------
  // Account-agnostic: bootstrap just needs to know whether this ticker is
  // held somewhere so it can decide between thesis-synthesis vs. watchlist
  // path. If the same ticker is held in multiple accounts we pick the first
  // open lot — synthesis only runs once per ticker regardless.
  const position = await prisma.position.findFirst({
    where: { ticker },
    include: { thesis: true },
  });
  const watchlist = await prisma.watchlist.findUnique({ where: { ticker } });
  if (!position && !watchlist) {
    throw new Error(
      `bootstrapTicker: ticker ${ticker} is not on a Position or Watchlist — add it first`,
    );
  }
  if (position) result.heldPosition = true;

  log.info?.({ ticker, heldPosition: result.heldPosition }, '[bootstrap] starting');

  // --- Step 2: Finnhub news (last N days) -------------------------------
  await fetchAndUpsertFinnhubNews(ticker, newsDays, log, result);

  // --- Step 3: EDGAR filings (last N days) ------------------------------
  await fetchAndUpsertEdgarFilings(ticker, filingsDays, log, result);

  // --- Step 4: Finnhub earnings calendar --------------------------------
  await fetchAndUpsertEarnings(ticker, log, result);

  // --- Step 5 + 6: thesis -----------------------------------------------
  if (position) {
    if (!position.thesis) {
      const synth = await synthesizeInitialThesis({
        ticker,
        position,
        log,
      });
      if (synth) {
        result.thesisInitialized = true;
        result.note = `synthesized pillars: ${synth.pillars.length}, riskFactors: ${synth.riskFactors.length}`;
        // Optional: run the baseline evaluation immediately so the Thesis
        // gets its first evidence attached. Use a 30d window.
        const evalRow = await evaluateThesis(position.id, {
          windowHours: newsDays * 24,
          log,
          sendTelegram: opts.sendTelegram ?? false,
        });
        if (evalRow) {
          result.thesisEvaluated = true;
          result.evaluationId = evalRow.id;
        }
      } else {
        result.note = 'thesis synthesis failed — Sonnet did not emit tool call';
      }
    } else {
      // Existing thesis ⇒ baseline evaluation over the ingested context.
      const evalRow = await evaluateThesis(position.id, {
        windowHours: newsDays * 24,
        log,
        sendTelegram: opts.sendTelegram ?? false,
      });
      if (evalRow) {
        result.thesisEvaluated = true;
        result.evaluationId = evalRow.id;
      }
    }
  } else {
    result.note = 'watchlist-only ticker — no Position, no thesis path';
  }

  log.info?.({ result }, '[bootstrap] complete');
  return result;
}

// ---------------------------------------------------------------------------
// Step 2: Finnhub news
// ---------------------------------------------------------------------------

async function fetchAndUpsertFinnhubNews(
  ticker: string,
  lookbackDays: number,
  log: FastifyBaseLogger | Console,
  out: BootstrapTickerResult,
): Promise<void> {
  const finnhub = getFinnhub();
  const to = new Date();
  const from = new Date(Date.now() - lookbackDays * 24 * 3600 * 1000);

  let items;
  try {
    items = await finnhub.getCompanyNews(ticker, from, to);
  } catch (err) {
    log.warn?.(
      { ticker, err: err instanceof Error ? err.message : err },
      '[bootstrap] finnhub company-news failed — continuing',
    );
    return;
  }
  out.articlesFetched = items.length;

  for (const item of items) {
    const { tier, domain, isSatire } = classifyDomain(item.url);
    if (isSatire) continue;

    const existing = await prisma.article.findUnique({
      where: { url: item.url },
      select: { id: true },
    });

    // Keep tickers as [TICKER] directly — bootstrap trusts the ticker-scoped
    // Finnhub query and skips the relevance filter sentinel. (Re-enqueueing
    // relevance on the article is still fine for defence-in-depth.)
    const article = await prisma.article.upsert({
      where: { url: item.url },
      create: {
        sourceTier: tier,
        source: 'finnhub',
        domain,
        url: item.url,
        headline: item.headline,
        body: item.body,
        publishedAt: item.publishedAt,
        tickers: [ticker],
        clusterId: null,
        trustedCitable: true,
        satireBlocked: false,
      },
      update: {
        sourceTier: tier,
        source: 'finnhub',
        domain,
        headline: item.headline,
        body: item.body,
        publishedAt: item.publishedAt,
        // Preserve existing tickers union [TICKER] so bootstrap doesn't strip
        // prior relevance-filter results.
      },
    });

    if (!existing) {
      out.articlesNew++;
      enqueueArticleEmbedding({
        articleId: article.id,
        headline: item.headline,
        body: item.body,
      });
      // Bootstrap articles come ticker-scoped; still enqueue relevance in
      // case Haiku downgrades (e.g. filter out irrelevant noise on the fringe).
      enqueueRelevanceCheck(article.id);
    }
  }
}

// ---------------------------------------------------------------------------
// Step 3: EDGAR filings
// ---------------------------------------------------------------------------

async function fetchAndUpsertEdgarFilings(
  ticker: string,
  lookbackDays: number,
  log: FastifyBaseLogger | Console,
  out: BootstrapTickerResult,
): Promise<void> {
  const edgar = getEdgar();
  const cutoff = Date.now() - lookbackDays * 24 * 3600 * 1000;

  let cik: string | null = null;
  try {
    cik = await edgar.getCikForTicker(ticker);
  } catch (err) {
    log.warn?.(
      { ticker, err: err instanceof Error ? err.message : err },
      '[bootstrap] edgar CIK lookup failed — skipping filings',
    );
    return;
  }
  if (!cik) {
    log.info?.({ ticker }, '[bootstrap] no CIK — non-US / unlisted ticker, skipping filings');
    return;
  }

  const FORMS = ['8-K', '10-Q', '10-K'] as const;
  for (const form of FORMS) {
    let filings;
    try {
      filings = await edgar.pollByTicker(ticker, form, 20);
    } catch (err) {
      log.warn?.(
        { ticker, form, err: err instanceof Error ? err.message : err },
        '[bootstrap] edgar pollByTicker failed — continuing',
      );
      continue;
    }
    out.filingsFetched += filings.length;
    for (const filing of filings) {
      if (filing.filedAt.getTime() < cutoff) continue;

      const existing = await prisma.article.findUnique({
        where: { url: filing.url },
        select: { id: true },
      });
      if (existing) continue;

      const headline = `${filing.ticker || ticker} ${filing.formType}: ${filing.title}`;
      const article = await prisma.article.create({
        data: {
          sourceTier: 1,
          source: 'edgar',
          domain: 'sec.gov',
          url: filing.url,
          headline,
          body: null,
          publishedAt: filing.filedAt,
          tickers: [ticker],
          clusterId: filing.accessionNumber ?? null,
          trustedCitable: true,
          satireBlocked: false,
        },
      });
      out.filingsNew++;
      enqueueArticleEmbedding({
        articleId: article.id,
        headline,
        body: null,
      });
      if (filing.formType === '8-K') {
        out.eightKsDetected++;
        await createMarketEvent({
          kind: EventKind.Filing8K,
          ticker,
          occurredAt: filing.filedAt,
          payload: {
            formType: filing.formType,
            companyName: filing.companyName,
            url: filing.url,
            accessionNumber: filing.accessionNumber,
            cik: filing.cik,
            articleId: article.id,
            bootstrap: true,
          },
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Step 4: Finnhub earnings calendar
// ---------------------------------------------------------------------------

async function fetchAndUpsertEarnings(
  ticker: string,
  log: FastifyBaseLogger | Console,
  out: BootstrapTickerResult,
): Promise<void> {
  const finnhub = getFinnhub();
  const from = new Date(Date.now() - 365 * 24 * 3600 * 1000);
  const to = new Date(Date.now() + 90 * 24 * 3600 * 1000);

  let items;
  try {
    items = await finnhub.getEarningsCalendar(from, to);
  } catch (err) {
    log.warn?.(
      { ticker, err: err instanceof Error ? err.message : err },
      '[bootstrap] finnhub earnings calendar failed',
    );
    return;
  }
  const scoped = items.filter((e) => (e.symbol ?? '').toUpperCase() === ticker);
  out.earningsFetched = scoped.length;

  // Sort by date descending so we can take the last 4 reported.
  const reported = scoped
    .filter((e) => e.epsActual !== null)
    .sort((a, b) => b.date.localeCompare(a.date));
  const lastFourReported = reported.slice(0, 4);

  for (const e of lastFourReported) {
    const occurredAt = new Date(`${e.date}T00:00:00Z`);
    const prior = await prisma.marketEvent.findFirst({
      where: {
        kind: EventKind.Earnings,
        ticker,
        occurredAt: {
          gte: new Date(`${e.date}T00:00:00Z`),
          lte: new Date(`${e.date}T23:59:59Z`),
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
    await createMarketEvent({
      kind: EventKind.Earnings,
      ticker,
      occurredAt,
      payload: {
        ticker,
        reportDate: e.date,
        actual,
        estimate,
        surprise,
        revenueActual: e.revenueActual,
        revenueEstimate: e.revenueEstimate,
        hour: e.hour,
        quarter: e.quarter,
        year: e.year,
        bootstrap: true,
      },
    });
    out.earningsNewActuals++;
  }

  // Upcoming — write synthetic catalyst-calendar Article rows (same contract
  // as pollEarnings so the dashboard catalyst page picks them up).
  const todayYmd = easternDateKey(new Date());
  for (const e of scoped) {
    if (!e.date || e.date <= todayYmd) continue;
    const url = `urn:finnhub:earnings:${ticker}:${e.date}`;
    const existing = await prisma.article.findUnique({
      where: { url },
      select: { id: true },
    });
    if (existing) continue;
    const headline = `${ticker} earnings ${e.date} (${e.hour || 'tbd'})`;
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
        publishedAt: new Date(`${e.date}T00:00:00Z`),
        tickers: [ticker],
        clusterId: null,
        trustedCitable: true,
        satireBlocked: false,
      },
    });
    out.earningsUpcomingWritten++;
    enqueueArticleEmbedding({
      articleId: article.id,
      headline,
      body,
    });
  }
}

// ---------------------------------------------------------------------------
// Step 5: initial thesis synthesis
// ---------------------------------------------------------------------------

interface SynthesizeInput {
  ticker: string;
  position: Position;
  log: FastifyBaseLogger | Console;
}

async function synthesizeInitialThesis(
  input: SynthesizeInput,
): Promise<InitialThesisPayload | null> {
  const { ticker, position, log } = input;

  // Pull the largest window of ingested context we have for this ticker —
  // post-bootstrap this includes everything from steps 2-4.
  const articles = await prisma.article.findMany({
    where: {
      tickers: { has: ticker },
      satireBlocked: false,
    },
    orderBy: [{ sourceTier: 'asc' }, { publishedAt: 'desc' }],
    take: 80,
  });
  const events = await prisma.marketEvent.findMany({
    where: { ticker },
    orderBy: { occurredAt: 'desc' },
    take: 20,
  });

  const userText = renderSynthesisUser({ ticker, position, articles, events });

  try {
    const result = await callClaude({
      model: SONNET_MODEL,
      system: buildSystemPrompt(),
      cacheSystem: true,
      messages: [{ role: 'user', content: userText }],
      tools: [EMIT_INITIAL_THESIS_TOOL],
      tool_choice: { type: 'tool', name: 'emit_initial_thesis' },
      purpose: 'bootstrap',
      maxTokens: 4096,
    });
    let found: InitialThesisPayload | null = null;
    for (const c of result.toolCalls as ParsedToolCall[]) {
      if (c.kind === 'emit_initial_thesis') {
        found = c.payload;
        break;
      }
    }
    // Parser guard — if the SDK shape upstream didn't match our parser for
    // whatever reason, try a last-ditch parse from the raw content.
    if (!found) {
      for (const block of result.response.content) {
        if (block.type !== 'tool_use') continue;
        if (block.name !== 'emit_initial_thesis') continue;
        const parsed = parseInitialThesis(block.input);
        if (parsed) {
          found = parsed;
          break;
        }
      }
    }
    if (!found) {
      log.warn?.(
        { ticker, stopReason: result.response.stop_reason },
        '[bootstrap] Sonnet emit_initial_thesis missing — aborting synth',
      );
      return null;
    }

    // Persist: shape pillars + risk factors so the evaluate engine can read
    // them back (status defaults Intact, triggered defaults false).
    const pillarsJson = found.pillars.map((p) => ({
      statement: p.statement,
      status: 'Intact' as const,
      lastEvaluatedAt: new Date().toISOString(),
      evidence: [] as Array<{ articleId: number; quote: string }>,
    }));
    const risksJson = found.riskFactors.map((r) => ({
      statement: r.statement,
      triggered: false,
      evidence: [] as Array<{ articleId: number; quote: string }>,
    }));

    const thesis: Thesis = await upsertThesis({
      positionId: position.id,
      summary: found.summary,
      pillars: pillarsJson as unknown as Prisma.InputJsonValue,
      riskFactors: risksJson as unknown as Prisma.InputJsonValue,
    });
    log.info?.(
      {
        ticker,
        thesisId: thesis.id,
        pillars: pillarsJson.length,
        riskFactors: risksJson.length,
      },
      '[bootstrap] initial thesis synthesized + persisted',
    );
    return found;
  } catch (err) {
    log.error?.(
      { ticker, err: err instanceof Error ? err.message : err },
      '[bootstrap] emit_initial_thesis call failed',
    );
    return null;
  }
}

function renderSynthesisUser(args: {
  ticker: string;
  position: Position;
  articles: Awaited<ReturnType<typeof prisma.article.findMany>>;
  events: Awaited<ReturnType<typeof prisma.marketEvent.findMany>>;
}): string {
  const { ticker, position, articles, events } = args;
  const lines: string[] = [];
  lines.push(`# Bootstrap — synthesize initial thesis for ${ticker}`);
  lines.push('');
  lines.push(`## Position metadata`);
  lines.push(`- ticker: ${ticker} (positionId ${position.id})`);
  lines.push(
    `- shares: ${position.shares.toString()} @ avg cost ${position.avgCost.toString()} ${position.currency}`,
  );
  lines.push(`- category: ${position.category}`);
  if (position.sector) lines.push(`- sector: ${position.sector}`);
  if (position.notes) lines.push(`- notes: ${position.notes}`);
  lines.push('');

  if (articles.length > 0) {
    lines.push(`## Ingested articles (${articles.length})`);
    lines.push('');
    const bodyLimit = 600;
    for (const a of articles) {
      const body = a.body ? a.body.slice(0, bodyLimit) : '';
      const trunc = a.body && a.body.length > bodyLimit ? ' …[truncated]' : '';
      lines.push(
        `[articleId: ${a.id}] (tier ${a.sourceTier} · ${a.source}${a.domain ? ` · ${a.domain}` : ''})`,
      );
      lines.push(`  ${a.publishedAt.toISOString()} — ${a.headline}`);
      if (body) lines.push(`  ${body.replace(/\s+/g, ' ').trim()}${trunc}`);
      lines.push('');
    }
  } else {
    lines.push('## Ingested articles');
    lines.push('(None — the bootstrap fetch produced zero articles.)');
    lines.push('');
  }

  if (events.length > 0) {
    lines.push(`## Market events (${events.length})`);
    for (const e of events) {
      lines.push(`- ${e.occurredAt.toISOString()} · ${e.kind}`);
    }
    lines.push('');
  }

  lines.push('# Instruction');
  lines.push('');
  lines.push(
    'Review the ingested context and propose an initial investment thesis by calling `emit_initial_thesis` exactly once. Requirements:',
    '- `summary`: one paragraph distilling why this is an ownable thesis right now.',
    '- `pillars`: 2-4 FALSIFIABLE statements. Each must be something a future earnings print, filing, or news cycle could disprove. Prefer concrete verbs + measurable outcomes.',
    '- `riskFactors`: 1-3 concrete ways this thesis could break. Specific events, not platitudes.',
    'Do not emit citations — the pillars will be backed by the subsequent thesis-evaluation pass.',
  );

  return lines.join('\n');
}
