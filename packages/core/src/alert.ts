/**
 * Alert builder — MarketEvent → Sonnet `emit_alert` → Insight.
 *
 * Called by the event-dispatch worker for each unprocessed MarketEvent. Returns
 * the created Insight on success, `null` when the event was suppressed (dedup
 * hit, per-ticker cap reached, citations all hallucinated, LLM chose "no alert
 * warranted"). Throws only for programmer errors (missing event). Operational
 * errors (spend cap, kill switch, network, Claude error) log and return null
 * WITHOUT marking the event processed — the next tick picks it up again.
 *
 * Pipeline:
 *   1. Load MarketEvent by id. If missing → throw. If processed → idempotency:
 *      return the existing Insight we emitted last time (matched on
 *      triggeredBy + clusterId).
 *   2. Alert-level dedup: ticker + `event:<kind>` trigger in last 6h
 *      (spec ### Source-tier + dedup rules).
 *   3. Per-ticker daily alert cap (spec non-functional line 58).
 *   4. Build context: Position, Thesis, recent Articles (24h, top 10 by
 *      recency + tier), event payload.
 *   5. Sonnet with `emit_alert` tool.
 *   6. Citation stripper — if no citations survive, log + mark processed +
 *      return null (noise we don't want to ship).
 *   7. Write Insight (kind=Alert, triggeredBy=`event:<kind>`, clusterId).
 *   8. Mark event processed.
 */

import {
  prisma,
  InsightKind,
  InsightStatus,
  Confidence,
  queueTelegramDelivery,
  type Insight,
  type MarketEvent,
  type Position,
  type Thesis,
  type Article,
  type Prisma,
  startOfZonedDay,
} from '@vantage/db';
import {
  callClaude,
  HAIKU_MODEL,
  buildSystemPrompt,
  EMIT_ALERT_TOOL,
  stripUncitedCall,
  LlmWrapperError,
  type ParsedToolCall,
  type AlertPayload,
  type Citation,
} from '@vantage/llm';
import { sendSelfAlert } from '@vantage/notify';
import { formatAlertForTelegram } from './formatter.js';

export interface BuildAlertLogger {
  info?: (obj: unknown, msg?: string) => void;
  warn?: (obj: unknown, msg?: string) => void;
  error?: (obj: unknown, msg?: string) => void;
  debug?: (obj: unknown, msg?: string) => void;
}

export interface BuildAlertOptions {
  log?: BuildAlertLogger;
  /**
   * Override the 6h dedup window (in ms). Tests use this to bypass the
   * window without a clock mock.
   */
  dedupWindowMs?: number;
  /** Override the article window (in hours). Defaults to 24h. */
  articleWindowHours?: number;
  /** Override max articles pulled into context. Defaults to 10. */
  maxArticles?: number;
}

const DEFAULT_DEDUP_MS = 6 * 60 * 60 * 1000;
const DEFAULT_ARTICLE_HOURS = 24;
const DEFAULT_MAX_ARTICLES = 10;

// Resilience guards — see docs/investigations/event-backlog-2026-05-22.md.
// During the 20-day Anthropic outage the dispatcher silently chewed through
// every tick without ever advancing the backlog and without paging us.
// FAILURE_ALERT_THRESHOLD: counter is process-local and re-arms after each
// fire (we reset to 0 once the self-alert ships) so a sustained outage gives
// us one ping per ~30-60 min sweep block instead of either silence or spam.
// MAX_RETRIES: per-event ceiling. After 24 ticks (~12 min at 30s cadence
// when the event is at the head of the queue, longer otherwise) we declare
// the event poisoned, stamp processedAt, and stash the failure in payload
// so it stays searchable but stops blocking the queue.
let consecutiveFailures = 0;
const FAILURE_ALERT_THRESHOLD = 50;
const MAX_RETRIES = 24;

/**
 * Main entry point. Idempotent per eventId: returns the already-built Insight
 * if the event was previously processed.
 */
export async function buildAlertFromEvent(
  eventId: number,
  opts: BuildAlertOptions = {},
): Promise<Insight | null> {
  const log = opts.log ?? defaultLog;
  const dedupMs = opts.dedupWindowMs ?? DEFAULT_DEDUP_MS;
  const articleHours = opts.articleWindowHours ?? DEFAULT_ARTICLE_HOURS;
  const maxArticles = opts.maxArticles ?? DEFAULT_MAX_ARTICLES;

  // --- Load event ---------------------------------------------------------
  const event = await prisma.marketEvent.findUnique({ where: { id: eventId } });
  if (!event) {
    throw new Error(`MarketEvent not found: id=${eventId}`);
  }

  const triggeredBy = `event:${event.kind}`;
  const clusterId = deriveClusterId(event);

  // Idempotency — event already processed. Return the prior Insight if we can
  // find it, otherwise null (e.g. event was marked processed due to a dedup
  // suppression on a previous tick).
  if (event.processedAt) {
    const prior = await prisma.insight.findFirst({
      where: { triggeredBy, clusterId },
      orderBy: { createdAt: 'desc' },
    });
    if (prior) {
      log.info?.(
        { eventId, priorInsightId: prior.id },
        '[core/alert] event already processed — returning existing Insight',
      );
      return prior;
    }
    log.info?.(
      { eventId },
      '[core/alert] event already processed — no prior Insight (suppressed before)',
    );
    return null;
  }

  // --- Alert-level dedup (6h cluster window) -----------------------------
  const since = new Date(Date.now() - dedupMs);
  const duplicate = await prisma.insight.findFirst({
    where: {
      kind: InsightKind.Alert,
      triggeredBy,
      clusterId,
      createdAt: { gte: since },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (duplicate) {
    log.info?.(
      {
        eventId,
        ticker: event.ticker,
        clusterId,
        duplicateInsightId: duplicate.id,
      },
      '[core/alert] dedup suppressed — duplicate Alert in last 6h',
    );
    await prisma.marketEvent.update({
      where: { id: eventId },
      data: { processedAt: new Date() },
    });
    return null;
  }

  // --- Per-ticker daily alert cap ----------------------------------------
  // NOTE: callClaude also enforces this when tickerContext.purpose === 'alert'
  // (throwing TickerCapError), but we check here first to avoid an
  // otherwise-wasted LLM call + to short-circuit cleanly.
  if (event.ticker) {
    const settings = await prisma.userSettings.findUnique({ where: { id: 1 } });
    const cap = settings?.perTickerDailyAlertCap ?? 3;
    const todayStart = startOfZonedDay(new Date(), settings?.timezone ?? undefined);
    const count = await prisma.insight.count({
      where: {
        kind: InsightKind.Alert,
        createdAt: { gte: todayStart },
        actionJson: { path: ['ticker'], equals: event.ticker },
      },
    });
    if (count >= cap) {
      log.info?.(
        { eventId, ticker: event.ticker, count, cap },
        '[core/alert] per-ticker daily alert cap reached — skipping',
      );
      await prisma.marketEvent.update({
        where: { id: eventId },
        data: { processedAt: new Date() },
      });
      return null;
    }
  }

  // --- Gather context ----------------------------------------------------
  const context = await gatherAlertContext(event, articleHours, maxArticles);

  // --- Call Sonnet -------------------------------------------------------
  let toolCall: ParsedToolCall | undefined;
  let llmCallId: number | null = null;
  try {
    const userText = renderUserMessage(event, context);
    const portfolioBlock = renderPortfolioBlock(context.position, context.thesis);

    const callParams: Parameters<typeof callClaude>[0] = {
      model: HAIKU_MODEL,
      system: buildSystemPrompt(),
      messages: [{ role: 'user', content: userText }],
      tools: [EMIT_ALERT_TOOL],
      purpose: 'alert',
      cacheSystem: true,
      maxTokens: 2048,
    };
    if (portfolioBlock) callParams.portfolio = portfolioBlock;
    if (event.ticker) {
      callParams.tickerContext = { ticker: event.ticker, purpose: 'alert' };
    }

    const result = await callClaude(callParams);
    llmCallId = result.llmCallId;
    // LLM round-trip succeeded — reset outage counter even if no alert fires.
    consecutiveFailures = 0;
    toolCall = result.toolCalls.find((c) => c.kind === 'emit_alert');
    if (!toolCall) {
      log.info?.(
        { eventId, llmCallId, stopReason: result.response.stop_reason },
        '[core/alert] Sonnet emitted no emit_alert tool call — treating as "no alert warranted"',
      );
      await prisma.marketEvent.update({
        where: { id: eventId },
        data: { processedAt: new Date() },
      });
      return null;
    }
  } catch (err) {
    if (err instanceof LlmWrapperError) {
      log.warn?.(
        { eventId, err: err.message, kind: err.name },
        '[core/alert] LLM wrapper blocked call — leaving event unprocessed',
      );
    } else {
      log.error?.(
        { eventId, err: err instanceof Error ? err.message : err },
        '[core/alert] Sonnet call failed — leaving event unprocessed',
      );
    }

    // --- Bounded retries (Guard 2) ---------------------------------------
    // Bump per-event retry counter regardless of error type — a kill-switch
    // sustained for 12+ minutes is still poison from this event's POV.
    const errMessage = err instanceof Error ? err.message : String(err);
    let updated;
    try {
      updated = await prisma.marketEvent.update({
        where: { id: eventId },
        data: { retryCount: { increment: 1 }, lastErrorAt: new Date() },
      });
    } catch (updateErr) {
      log.error?.(
        { eventId, err: updateErr instanceof Error ? updateErr.message : updateErr },
        '[core/alert] failed to bump retryCount — event will retry indefinitely until DB recovers',
      );
    }
    if (updated && updated.retryCount >= MAX_RETRIES) {
      const basePayload =
        updated.payload && typeof updated.payload === 'object' && !Array.isArray(updated.payload)
          ? (updated.payload as Record<string, unknown>)
          : {};
      const failedPayload = {
        ...basePayload,
        processingFailed: true,
        lastError: errMessage,
      };
      await prisma.marketEvent.update({
        where: { id: eventId },
        data: {
          processedAt: new Date(),
          payload: failedPayload as Prisma.InputJsonValue,
        },
      });
      log.error?.(
        { eventId, retryCount: updated.retryCount, lastError: errMessage },
        '[core/alert] event hit MAX_RETRIES — marking processed with failure flag',
      );
    }

    // --- Consecutive-failure self-alert (Guard 1) ------------------------
    // Counter is process-local so a worker restart resets the clock — fine,
    // because a restart is itself a recovery signal and the next outage gets
    // a fresh chance to ping us.
    consecutiveFailures++;
    if (consecutiveFailures >= FAILURE_ALERT_THRESHOLD) {
      void sendSelfAlert(
        'critical',
        `Alert dispatcher: ${consecutiveFailures} consecutive failures — LLM likely down. Event queue is stalled.`,
        {
          eventId,
          lastError: errMessage,
          errorKind: err instanceof Error ? err.name : 'Unknown',
        },
      );
      // Re-arm: next THRESHOLD failures will fire another ping. Keeps a
      // sustained outage visible without spamming.
      consecutiveFailures = 0;
    }

    return null;
  }

  // --- Strip uncited claims ----------------------------------------------
  const { call: stripped, droppedCitations } = await stripUncitedCall(toolCall);
  if (!stripped || stripped.kind !== 'emit_alert') {
    log.warn?.(
      { eventId, llmCallId, droppedCitations: droppedCitations.length },
      '[core/alert] all citations hallucinated — dropping alert + marking event processed',
    );
    await prisma.marketEvent.update({
      where: { id: eventId },
      data: { processedAt: new Date() },
    });
    return null;
  }

  const payload: AlertPayload = stripped.payload;

  // --- Persist + mark processed in a transaction -------------------------
  const actionJson = buildActionJson(event, payload, context);
  const citationsJson = toJsonCitations(payload.citations);

  const insight = await prisma.$transaction(async (tx) => {
    const created = await tx.insight.create({
      data: {
        kind: InsightKind.Alert,
        title: payload.title,
        body: payload.body,
        reasoning: payload.reasoning,
        citations: citationsJson,
        actionJson,
        confidence: inferConfidence(payload.citations, context.articles),
        status: InsightStatus.New,
        triggeredBy,
        clusterId,
      },
    });
    const linkBase = process.env['DASHBOARD_BASE_URL'] ?? 'http://localhost:3000';
    await queueTelegramDelivery(
      {
        dedupeKey: `insight:${created.id}`,
        text: formatAlertForTelegram(created, linkBase),
        parseMode: 'Markdown',
        disableWebPagePreview: true,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
      tx,
    );
    await tx.marketEvent.update({
      where: { id: eventId },
      data: { processedAt: new Date() },
    });
    return created;
  });

  // LLM is alive and we shipped — clear the outage counter.
  consecutiveFailures = 0;

  log.info?.(
    {
      eventId,
      insightId: insight.id,
      ticker: event.ticker,
      llmCallId,
      citationCount: payload.citations.length,
      droppedCitations: droppedCitations.length,
    },
    '[core/alert] Alert insight created and queued for Telegram',
  );

  return insight;
}

// ---------------------------------------------------------------------------
// Context gathering
// ---------------------------------------------------------------------------

interface AlertContext {
  ticker: string | null;
  position: Position | null;
  thesis: Thesis | null;
  articles: Article[];
  latestPrice: LatestPriceSnapshot | null;
}

interface LatestPriceSnapshot {
  articleId?: number;
  /** Free-form summary pulled from event.payload — no price source yet. */
  summary: string;
}

async function gatherAlertContext(
  event: MarketEvent,
  articleHours: number,
  maxArticles: number,
): Promise<AlertContext> {
  const ticker = event.ticker ?? null;
  const since = new Date(Date.now() - articleHours * 3600 * 1000);

  const [position, articles] = await Promise.all([
    ticker
      ? // Account-agnostic lookup: alert context only needs to know "do we hold
        // this ticker anywhere?" — first matching open lot is sufficient since
        // the alert body doesn't reason about per-account economics.
        prisma.position.findFirst({ where: { ticker, closedAt: null } })
      : Promise.resolve(null),
    ticker
      ? prisma.article.findMany({
          where: {
            tickers: { has: ticker },
            satireBlocked: false,
            publishedAt: { gte: since },
          },
          orderBy: [{ publishedAt: 'desc' }, { sourceTier: 'asc' }],
          take: maxArticles,
        })
      : Promise.resolve<Article[]>([]),
  ]);

  const thesis = position
    ? await prisma.thesis.findUnique({ where: { positionId: position.id } })
    : null;

  const latestPrice = summarizePriceFromEvent(event);

  return {
    ticker,
    position,
    thesis,
    articles,
    latestPrice,
  };
}

function summarizePriceFromEvent(event: MarketEvent): LatestPriceSnapshot | null {
  const p = event.payload as Record<string, unknown> | null;
  if (!p || typeof p !== 'object') return null;
  // Best-effort: surface whatever intraday-move or earnings fields exist.
  const keys = ['pctChange', 'price', 'last', 'surprisePct', 'epsActual'];
  const bits: string[] = [];
  for (const k of keys) {
    const v = p[k];
    if (typeof v === 'number' && Number.isFinite(v)) {
      bits.push(`${k}=${v}`);
    } else if (typeof v === 'string' && v.length > 0) {
      bits.push(`${k}=${v}`);
    }
  }
  if (bits.length === 0) return null;
  return { summary: bits.join(', ') };
}

// ---------------------------------------------------------------------------
// Prompt rendering
// ---------------------------------------------------------------------------

function renderPortfolioBlock(
  position: Position | null,
  thesis: Thesis | null,
): string | undefined {
  if (!position) return undefined;
  const lines: string[] = [
    '# Current position',
    '',
    `- Ticker: ${position.ticker} (positionId: ${position.id})`,
    `- Shares: ${position.shares.toString()} @ avg cost ${position.avgCost.toString()} ${position.currency}`,
    `- Category: ${position.category}`,
  ];
  if (position.sector) lines.push(`- Sector: ${position.sector}`);
  if (position.notes) lines.push(`- Notes: ${position.notes}`);
  if (thesis) {
    lines.push('', '## Thesis', `- Status: ${thesis.status}`, `- Summary: ${thesis.summary}`);
    const pillars = thesis.pillars;
    if (Array.isArray(pillars) && pillars.length > 0) {
      lines.push('- Pillars:');
      for (const pillar of pillars as Array<Record<string, unknown>>) {
        const statement =
          typeof pillar['statement'] === 'string' ? pillar['statement'] : JSON.stringify(pillar);
        lines.push(`  - ${statement}`);
      }
    }
    const risks = thesis.riskFactors;
    if (Array.isArray(risks) && risks.length > 0) {
      lines.push('- Risk factors:');
      for (const risk of risks as Array<Record<string, unknown>>) {
        const statement =
          typeof risk['statement'] === 'string' ? risk['statement'] : JSON.stringify(risk);
        lines.push(`  - ${statement}`);
      }
    }
  }
  lines.push('');
  return lines.join('\n');
}

function renderUserMessage(event: MarketEvent, ctx: AlertContext): string {
  const parts: string[] = [];
  parts.push('# Incoming market event');
  parts.push('');
  parts.push(`- Event kind: ${event.kind}`);
  if (event.ticker) parts.push(`- Ticker: ${event.ticker}`);
  parts.push(`- Occurred at: ${event.occurredAt.toISOString()}`);
  if (ctx.latestPrice) {
    parts.push(`- Event signal: ${ctx.latestPrice.summary}`);
  }
  parts.push('- Payload:');
  parts.push('```json');
  parts.push(safeStringify(event.payload));
  parts.push('```');
  parts.push('');

  if (ctx.articles.length > 0) {
    parts.push(
      `# Recent articles for ${ctx.ticker ?? 'this event'} (last ${DEFAULT_ARTICLE_HOURS}h, ${ctx.articles.length} articles)`,
    );
    parts.push('');
    parts.push(
      'Every claim you emit must cite one of these by `articleId`. Prefer tier-1 (Reuters, Bloomberg, AP, SEC) over tier-2 and tier-3 (StockTwits).',
    );
    parts.push('');
    for (const a of ctx.articles) {
      const body = a.body ? a.body.slice(0, 800) : '';
      const tickerTag = a.tickers.length > 0 ? ` · tickers: ${a.tickers.join(', ')}` : '';
      parts.push(
        `[articleId: ${a.id}] (tier ${a.sourceTier} · ${a.source}${a.domain ? ` · ${a.domain}` : ''}${tickerTag})`,
        `  ${a.publishedAt.toISOString()} — ${a.headline}`,
      );
      if (body) {
        parts.push(`  ${body.replace(/\s+/g, ' ').trim()}`);
      }
      parts.push('');
    }
  } else {
    parts.push(
      '# Recent articles',
      '',
      '(No recent articles found for this ticker in the context window.)',
      '',
    );
  }

  parts.push(
    '# Instruction',
    '',
    'Review the event and the cited articles. Decide whether this warrants a user-facing alert. If yes, call `emit_alert` with a concise title (≤100 chars), a prose body, your internal reasoning, and at least one citation referencing an article above. If the event is routine/non-material or insufficient evidence to support an alert, emit NO tool call.',
  );

  return parts.join('\n');
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deriveClusterId(event: MarketEvent): string {
  // Prefer the event's own stored cluster key if the source put one in payload
  // (Phase 6 ingestion sets clusterId on Article; MarketEvent payload may echo
  // it for news-triggered events). Otherwise synthesize from kind+ticker+
  // occurredAt so two events in the same 6h bucket dedup against each other.
  const p =
    event.payload && typeof event.payload === 'object'
      ? (event.payload as Record<string, unknown>)
      : {};
  if (typeof p['clusterId'] === 'string' && (p['clusterId'] as string).length > 0) {
    return p['clusterId'] as string;
  }
  const bucket = Math.floor(event.occurredAt.getTime() / (6 * 3600 * 1000));
  const ticker = event.ticker ?? 'NONE';
  return `event:${event.kind}:${ticker}:${bucket}`;
}

function buildActionJson(
  event: MarketEvent,
  payload: AlertPayload,
  ctx: AlertContext,
): Prisma.InputJsonValue {
  const out: Record<string, unknown> = {
    type: 'alert',
    kind: payload.kind,
    eventKind: event.kind,
    eventId: event.id,
  };
  if (event.ticker) out['ticker'] = event.ticker;
  if (ctx.latestPrice) out['priceSnapshot'] = ctx.latestPrice.summary;
  return out as Prisma.InputJsonValue;
}

function toJsonCitations(citations: Citation[]): Prisma.InputJsonValue {
  return citations.map((c) => ({
    articleId: c.articleId,
    quote: c.quote,
  })) as Prisma.InputJsonValue;
}

/**
 * Confidence heuristic aligned with the spec's source-tier rules:
 *   - If ≥1 citation resolves to a tier-1 article → High (downgraded below).
 *   - If all resolved citations are tier-3 → Low.
 *   - Otherwise → Medium.
 * Note: the stripper already dropped hallucinated citations, so every citation
 * here corresponds to a real Article in `ctx.articles` when possible.
 */
function inferConfidence(citations: Citation[], articles: Article[]): Confidence {
  if (citations.length === 0) return Confidence.Low;
  const articleById = new Map<number, Article>();
  for (const a of articles) articleById.set(a.id, a);
  let hasTier1 = false;
  let allTier3 = true;
  for (const c of citations) {
    const a = articleById.get(c.articleId);
    const tier = a?.sourceTier ?? 2; // unknown-tier defaults to tier-2 treatment
    if (tier === 1) hasTier1 = true;
    if (tier !== 3) allTier3 = false;
  }
  if (hasTier1) return Confidence.High;
  if (allTier3) return Confidence.Low;
  return Confidence.Medium;
}

const defaultLog: BuildAlertLogger = {
  info: (obj, msg) => console.info(msg ?? '', obj),
  warn: (obj, msg) => console.warn(msg ?? '', obj),
  error: (obj, msg) => console.error(msg ?? '', obj),
  debug: (obj, msg) => console.debug(msg ?? '', obj),
};
