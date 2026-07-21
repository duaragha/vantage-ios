/**
 * Thesis evaluation engine.
 *
 * Responsibilities:
 *   1. Load Position + Thesis + pillars + riskFactors.
 *   2. Pull time-windowed Articles (default 72h) + MarketEvents for the ticker.
 *   3. Apply keyword pre-filter (hasTickerMention) — drop articles that don't
 *      mention the ticker or its aliases.
 *   4. Apply tier / satire filter — satire never enters context, tier-3 capped
 *      so noise can't drown tier-1 evidence.
 *   5. Per-pillar scoring via a single Sonnet call emitting an
 *      `emit_thesis_eval` tool call. Prompt caching on system + portfolio.
 *   6. Strip uncited pillar scores (evidence articleIds that don't resolve).
 *      Pillars whose evidence list fails the stripper are coerced to
 *      status=Intact rather than dropped, so unclassifiable pillars can't
 *      falsely move the thesis.
 *   7. Aggregate pillar statuses → overall ThesisStatus.
 *   8. Update Thesis.pillars JSON with per-pillar status + lastEvaluatedAt +
 *      evidence, Thesis.riskFactors with any risk triggers, Thesis.status +
 *      Thesis.lastValidatedAt.
 *   9. Insert ThesisEvaluation row with prevStatus/newStatus/rationale/
 *      citations.
 *  10. Leave the rationale for the shared embedding batch to process.
 *  11. If the new status differs from prev: create an Insight kind=ThesisUpdate
 *      (triggeredBy=`thesis-eval`) and atomically queue a Telegram message
 *      while respecting the per-ticker cap.
 *  12. Return the ThesisEvaluation row.
 *
 * Entry points:
 *   - evaluateThesis(positionId, opts?)                   → single position
 *
 * Aggregation rule (spec Phase 9 task brief):
 *   - any pillar Broken          → Broken
 *   - majority Weakening         → Weakening
 *   - majority Strengthening     → Strengthening
 *   - otherwise                  → Intact
 */

import {
  prisma,
  Confidence,
  InsightKind,
  InsightStatus,
  queueTelegramDelivery,
  ThesisStatus,
  type Article,
  type Insight,
  type MarketEvent,
  type Position,
  type Thesis,
  type ThesisEvaluation,
  type Prisma,
  startOfZonedDay,
} from '@vantage/db';
import {
  callClaude,
  SONNET_MODEL,
  buildSystemPrompt,
  buildPortfolioContext,
  EMIT_THESIS_EVAL_TOOL,
  hasTickerMention,
  type ParsedToolCall,
  type ThesisEvalPayload,
  type PillarEvaluation,
  type PillarEvaluationEvidence,
  type PillarEvaluationStatus,
  type RiskFactorUpdate,
  type Citation,
  type TickerSpec,
} from '@vantage/llm';
import { formatInsightForTelegram } from './formatter.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ThesisEvalLogger {
  info?: (obj: unknown, msg?: string) => void;
  warn?: (obj: unknown, msg?: string) => void;
  error?: (obj: unknown, msg?: string) => void;
  debug?: (obj: unknown, msg?: string) => void;
}

export interface EvaluateThesisOptions {
  log?: ThesisEvalLogger;
  /** Time window in hours for the article pull. Default 72h. */
  windowHours?: number;
  /** Max articles (post-filter) passed to the model. Default 40. */
  maxArticles?: number;
  /** Max tier-3 articles admitted (capped to avoid noise). Default 6. */
  maxTier3Articles?: number;
  /**
   * When the thesis status changes, queue a Telegram message. Set to false in
   * tests when only the persisted Insight is under test.
   * Default true.
   */
  sendTelegram?: boolean;
}

// Shape persisted to Thesis.pillars JSON.
export interface PersistedPillar {
  statement: string;
  status: PillarEvaluationStatus;
  lastEvaluatedAt: string; // ISO
  evidence: PillarEvaluationEvidence[];
}

// Shape persisted to Thesis.riskFactors JSON.
export interface PersistedRiskFactor {
  statement: string;
  triggered: boolean;
  evidence: PillarEvaluationEvidence[];
}

// ---------------------------------------------------------------------------
// Constants / defaults
// ---------------------------------------------------------------------------

const DEFAULT_WINDOW_HOURS = 72;
const DEFAULT_MAX_ARTICLES = 40;
const DEFAULT_MAX_TIER3 = 6;

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Evaluate a position's thesis against time-windowed Articles + MarketEvents.
 *
 * Returns null only when the position or thesis is missing, or when the model
 * refused to emit a tool call (no-change signal). Any DB/Claude wrapper errors
 * bubble up to the caller.
 */
export async function evaluateThesis(
  positionId: number,
  opts: EvaluateThesisOptions = {},
): Promise<ThesisEvaluation | null> {
  const log = opts.log ?? defaultLog;
  const windowHours = opts.windowHours ?? DEFAULT_WINDOW_HOURS;
  const maxArticles = opts.maxArticles ?? DEFAULT_MAX_ARTICLES;
  const maxTier3 = opts.maxTier3Articles ?? DEFAULT_MAX_TIER3;
  const sendTelegramFlag = opts.sendTelegram !== false;

  // --- Load position + thesis + settings ---------------------------------
  const position = await prisma.position.findUnique({
    where: { id: positionId },
    include: { thesis: true },
  });
  if (!position) {
    log.warn?.({ positionId }, '[core/thesis] position not found');
    return null;
  }
  if (!position.thesis) {
    log.warn?.(
      { positionId, ticker: position.ticker },
      '[core/thesis] position has no thesis — nothing to evaluate',
    );
    return null;
  }

  const pillarsIn = normalizePillars(position.thesis.pillars);
  const risksIn = normalizeRisks(position.thesis.riskFactors);
  if (pillarsIn.length === 0) {
    log.warn?.(
      { positionId, ticker: position.ticker },
      '[core/thesis] thesis has zero pillars — skipping',
    );
    return null;
  }

  // --- Pull article window + events --------------------------------------
  const since = new Date(Date.now() - windowHours * 3600 * 1000);
  const ticker = position.ticker.toUpperCase();
  const rawArticles = await prisma.article.findMany({
    where: {
      tickers: { has: ticker },
      satireBlocked: false,
      publishedAt: { gte: since },
    },
    // Tier 1 first within same-timestamp groups so high-signal wins article
    // truncation ties.
    orderBy: [{ sourceTier: 'asc' }, { publishedAt: 'desc' }],
    take: maxArticles * 2,
  });

  const events = await prisma.marketEvent.findMany({
    where: {
      ticker,
      occurredAt: { gte: since },
    },
    orderBy: { occurredAt: 'desc' },
    take: 30,
  });

  // Keyword pre-filter — defence in depth. Article.tickers should already be
  // populated via the relevance filter, but belt + suspenders on bootstrap
  // ingests and freshly-imported rows.
  const tickerSpec: TickerSpec[] = [{ symbol: ticker }];
  const keywordFiltered = rawArticles.filter((a) => {
    if (a.tickers.includes(ticker)) return true;
    const hay = `${a.headline}\n\n${a.body ?? ''}`;
    return hasTickerMention(hay, tickerSpec).length > 0;
  });

  // Tier-3 cap — keep high-signal tier-1/2 intact and admit at most N tier-3.
  const tier3 = keywordFiltered.filter((a) => a.sourceTier === 3).slice(0, maxTier3);
  const tier12 = keywordFiltered.filter((a) => a.sourceTier !== 3);
  const articles: Article[] = [...tier12, ...tier3]
    // Re-sort by publish time so the prompt reads chronologically (newest first).
    .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())
    .slice(0, maxArticles);

  log.info?.(
    {
      positionId,
      ticker,
      windowHours,
      rawArticles: rawArticles.length,
      afterKeyword: keywordFiltered.length,
      afterCaps: articles.length,
      events: events.length,
      pillars: pillarsIn.length,
      risks: risksIn.length,
    },
    '[core/thesis] context gathered',
  );

  // --- Build prompt + call Sonnet ----------------------------------------
  const [systemText, portfolioText] = await Promise.all([
    Promise.resolve(buildSystemPrompt()),
    buildPortfolioContext(),
  ]);

  const userText = renderUserMessage({
    position,
    thesis: position.thesis,
    pillars: pillarsIn,
    risks: risksIn,
    articles,
    events,
    windowHours,
  });

  let thesisEvalCall: Extract<ParsedToolCall, { kind: 'emit_thesis_eval' }> | undefined;
  try {
    const result = await callClaude({
      model: SONNET_MODEL,
      system: systemText,
      portfolio: portfolioText,
      cacheSystem: true,
      cachePortfolio: true,
      messages: [{ role: 'user', content: userText }],
      tools: [EMIT_THESIS_EVAL_TOOL],
      tool_choice: { type: 'tool', name: 'emit_thesis_eval' },
      purpose: 'thesis-eval',
      maxTokens: 4096,
      tickerContext: { ticker, purpose: 'thesis-eval' },
    });
    for (const c of result.toolCalls) {
      if (c.kind === 'emit_thesis_eval') {
        thesisEvalCall = c;
        break;
      }
    }
    if (!thesisEvalCall) {
      log.warn?.(
        { positionId, ticker, stopReason: result.response.stop_reason },
        '[core/thesis] Sonnet emitted no emit_thesis_eval tool call',
      );
      return null;
    }
  } catch (err) {
    log.error?.(
      { positionId, ticker, err: err instanceof Error ? err.message : err },
      '[core/thesis] Sonnet call failed',
    );
    return null;
  }

  const payload: ThesisEvalPayload = thesisEvalCall.payload;

  // --- Citation stripping -------------------------------------------------
  const articleIds = new Set(articles.map((a) => a.id));
  const strippedPillars = normalizePillarScoresWithStripping(
    pillarsIn.length,
    payload.pillarScores,
    articleIds,
    log,
  );
  const strippedRisks = normalizeRiskUpdatesWithStripping(
    risksIn.length,
    payload.riskFactorUpdates,
    articleIds,
    log,
  );
  const strippedOverallCitations = payload.overallCitations.filter((c) =>
    articleIds.has(c.articleId),
  );

  // --- Aggregate overall status ------------------------------------------
  const aggregateStatus = aggregatePillarStatuses(strippedPillars.map((p) => p.status));

  // --- Persist Thesis updates --------------------------------------------
  const lastEvaluatedAt = new Date().toISOString();
  const persistedPillars: PersistedPillar[] = pillarsIn.map((pillarIn, idx) => {
    const scored = strippedPillars.find((p) => p.pillarIndex === idx);
    return {
      statement: pillarIn.statement,
      status: scored?.status ?? ThesisStatus.Intact,
      lastEvaluatedAt,
      evidence: scored?.evidence ?? [],
    };
  });
  const persistedRisks: PersistedRiskFactor[] = risksIn.map((riskIn, idx) => {
    const update = strippedRisks.find((r) => r.riskIndex === idx);
    return {
      statement: riskIn.statement,
      triggered: update?.triggered ?? Boolean(riskIn.triggered),
      evidence: update?.evidence ?? riskIn.evidence,
    };
  });

  const prevStatus = position.thesis.status;
  const newStatus = toThesisStatusEnum(aggregateStatus);

  // Use a transaction so a DB hiccup can't split the Thesis update and the
  // ThesisEvaluation insert.
  const { thesisEvaluation } = await prisma.$transaction(async (tx) => {
    await tx.thesis.update({
      where: { id: position.thesis!.id },
      data: {
        pillars: persistedPillars as unknown as Prisma.InputJsonValue,
        riskFactors: persistedRisks as unknown as Prisma.InputJsonValue,
        status: newStatus,
        lastValidatedAt: new Date(),
      },
    });
    const evalRow = await tx.thesisEvaluation.create({
      data: {
        thesisId: position.thesis!.id,
        prevStatus,
        newStatus,
        rationale: payload.overallRationale,
        citations: strippedOverallCitations as unknown as Prisma.InputJsonValue,
      },
    });
    return { thesisEvaluation: evalRow };
  });

  // --- Status-change hook -------------------------------------------------
  if (newStatus !== prevStatus) {
    await emitThesisUpdateInsight({
      ticker,
      position,
      thesisId: position.thesis.id,
      prevStatus,
      newStatus,
      rationale: payload.overallRationale,
      citations: strippedOverallCitations,
      articles,
      sendTelegramFlag,
      log,
    });
  } else {
    log.info?.(
      { positionId, ticker, status: newStatus },
      '[core/thesis] no status change — Insight not created',
    );
  }

  log.info?.(
    {
      positionId,
      ticker,
      evaluationId: thesisEvaluation.id,
      prevStatus,
      newStatus,
      pillarsChanged: persistedPillars.filter((p) => p.status !== ThesisStatus.Intact).length,
      risksTriggered: persistedRisks.filter((r) => r.triggered).length,
    },
    '[core/thesis] evaluation complete',
  );

  return thesisEvaluation;
}

// ---------------------------------------------------------------------------
// Prompt rendering
// ---------------------------------------------------------------------------

interface RenderInput {
  position: Position;
  thesis: Thesis;
  pillars: NormalizedPillarIn[];
  risks: NormalizedRiskIn[];
  articles: Article[];
  events: MarketEvent[];
  windowHours: number;
}

function renderUserMessage(input: RenderInput): string {
  const { position, thesis, pillars, risks, articles, events, windowHours } = input;
  const lines: string[] = [];
  lines.push(`# Thesis evaluation — ${position.ticker} (positionId ${position.id})`);
  lines.push('');
  lines.push(`- Current thesis status: ${thesis.status}`);
  lines.push(`- Last validated: ${thesis.lastValidatedAt.toISOString()}`);
  lines.push(`- Article window: last ${windowHours}h`);
  lines.push('');
  lines.push(`## Thesis summary`);
  lines.push(thesis.summary);
  lines.push('');

  lines.push('## Pillars (score each — same order, zero-based index)');
  pillars.forEach((p, idx) => {
    lines.push(`- [pillarIndex: ${idx}] ${p.statement}`);
    if (p.status) lines.push(`    current status: ${p.status}`);
  });
  lines.push('');

  lines.push('## Risk factors (zero-based index)');
  risks.forEach((r, idx) => {
    const suffix = r.triggered ? ' (currently TRIGGERED)' : '';
    lines.push(`- [riskIndex: ${idx}] ${r.statement}${suffix}`);
  });
  lines.push('');

  // Article window.
  if (articles.length === 0) {
    lines.push('## Article window');
    lines.push('');
    lines.push(
      '(No qualifying articles in the window — prefer "Intact" for all pillars with empty evidence.)',
    );
    lines.push('');
  } else {
    lines.push(`## Article window (${articles.length} articles)`);
    lines.push('');
    lines.push(
      'Cite by `articleId`. Tier 1 (Reuters/Bloomberg/AP/SEC) > Tier 2 > Tier 3 (StockTwits). Tier-3 cannot be the sole support for a Broken verdict.',
    );
    lines.push('');
    const bodyLimit = 800;
    for (const a of articles) {
      const body = a.body ? a.body.slice(0, bodyLimit) : '';
      const trunc = a.body && a.body.length > bodyLimit ? ' …[truncated]' : '';
      const tickers = a.tickers.length > 0 ? ` · tickers: ${a.tickers.join(', ')}` : '';
      lines.push(
        `[articleId: ${a.id}] (tier ${a.sourceTier} · ${a.source}${a.domain ? ` · ${a.domain}` : ''}${tickers})`,
      );
      lines.push(`  ${a.publishedAt.toISOString()} — ${a.headline}`);
      if (body) lines.push(`  ${body.replace(/\s+/g, ' ').trim()}${trunc}`);
      lines.push('');
    }
  }

  if (events.length > 0) {
    lines.push(`## Market events (${events.length})`);
    lines.push('');
    for (const e of events) {
      lines.push(
        `- ${e.occurredAt.toISOString()} · ${e.kind} · payload: ${safeStringify(e.payload)}`,
      );
    }
    lines.push('');
  }

  lines.push('# Instruction');
  lines.push('');
  lines.push(
    [
      'Call `emit_thesis_eval` exactly once. For each pillar, return a status and the specific articles (articleId + short verbatim quote) supporting that status. If the window contains no evidence for a pillar, return status=Intact with an empty evidence array. Update any risk factors whose state has flipped. Return an aggregate `overallStatus` consistent with: any pillar Broken → Broken; majority Weakening → Weakening; majority Strengthening → Strengthening; otherwise Intact. Provide `overallRationale` as a concise paragraph and `overallCitations` as the top-level roll-up of the strongest 1-4 citations.',
    ].join(''),
  );

  return lines.join('\n');
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ---------------------------------------------------------------------------
// Status-change Insight + Telegram
// ---------------------------------------------------------------------------

interface EmitInput {
  ticker: string;
  position: Position;
  thesisId: number;
  prevStatus: ThesisStatus;
  newStatus: ThesisStatus;
  rationale: string;
  citations: Citation[];
  articles: Article[];
  sendTelegramFlag: boolean;
  log: ThesisEvalLogger;
}

async function emitThesisUpdateInsight(input: EmitInput): Promise<Insight> {
  const {
    ticker,
    position,
    thesisId,
    prevStatus,
    newStatus,
    rationale,
    citations,
    articles,
    sendTelegramFlag,
    log,
  } = input;

  // Per-ticker cap check — we still write the Insight either way, but skip
  // Telegram when the cap is saturated.
  const settings = await prisma.userSettings.findUnique({ where: { id: 1 } });
  const cap = settings?.perTickerDailyAlertCap ?? 3;
  const todayStart = startOfZonedDay(new Date(), settings?.timezone ?? undefined);
  const existingToday = await prisma.insight.count({
    where: {
      createdAt: { gte: todayStart },
      actionJson: { path: ['ticker'], equals: ticker },
    },
  });
  const capReached = existingToday >= cap;

  const title = `${ticker}: Thesis ${prevStatus} → ${newStatus}`;
  const body = rationale;
  const confidence = inferConfidence(citations, articles);

  const actionJson: Record<string, unknown> = {
    type: 'thesis-update',
    ticker,
    positionId: position.id,
    thesisId,
    prevStatus,
    newStatus,
  };

  const insight = await prisma.$transaction(async (tx) => {
    const created = await tx.insight.create({
      data: {
        kind: InsightKind.ThesisUpdate,
        title,
        body,
        reasoning: rationale,
        citations: citations.map((c) => ({
          articleId: c.articleId,
          quote: c.quote,
        })) as unknown as Prisma.InputJsonValue,
        actionJson: actionJson as unknown as Prisma.InputJsonValue,
        confidence,
        status: InsightStatus.New,
        triggeredBy: 'thesis-eval',
      },
    });

    if (sendTelegramFlag && !capReached) {
      const linkBase = process.env['DASHBOARD_BASE_URL'] ?? 'http://localhost:3000';
      await queueTelegramDelivery(
        {
          dedupeKey: `insight:${created.id}`,
          text: formatInsightForTelegram(created, { deepLinkBase: linkBase }),
          parseMode: 'Markdown',
          disableWebPagePreview: true,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
        tx,
      );
    }

    return created;
  });
  log.info?.(
    { insightId: insight.id, ticker, prevStatus, newStatus },
    '[core/thesis] ThesisUpdate Insight created',
  );

  if (!sendTelegramFlag) {
    log.info?.(
      { insightId: insight.id, ticker },
      '[core/thesis] sendTelegram=false — skipping Telegram queue',
    );
    return insight;
  }

  if (capReached) {
    log.info?.(
      { insightId: insight.id, ticker, cap, existingToday },
      '[core/thesis] per-ticker alert cap reached — insight written, Telegram not queued',
    );
    return insight;
  }

  log.info?.({ insightId: insight.id, ticker }, '[core/thesis] ThesisUpdate queued for Telegram');

  return insight;
}

// ---------------------------------------------------------------------------
// Normalisation helpers — Thesis.pillars / riskFactors are `Json`
// ---------------------------------------------------------------------------

interface NormalizedPillarIn {
  statement: string;
  status?: PillarEvaluationStatus;
  evidence?: PillarEvaluationEvidence[];
}

interface NormalizedRiskIn {
  statement: string;
  triggered: boolean;
  evidence: PillarEvaluationEvidence[];
}

function normalizePillars(raw: unknown): NormalizedPillarIn[] {
  if (!Array.isArray(raw)) return [];
  const out: NormalizedPillarIn[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const o = entry as Record<string, unknown>;
    const statement = typeof o['statement'] === 'string' ? (o['statement'] as string) : '';
    if (!statement) continue;
    const pillar: NormalizedPillarIn = { statement };
    if (typeof o['status'] === 'string' && isPillarStatusRuntime(o['status'] as string)) {
      pillar.status = o['status'] as PillarEvaluationStatus;
    }
    if (Array.isArray(o['evidence'])) {
      pillar.evidence = parseEvidenceArray(o['evidence']);
    }
    out.push(pillar);
  }
  return out;
}

function normalizeRisks(raw: unknown): NormalizedRiskIn[] {
  if (!Array.isArray(raw)) return [];
  const out: NormalizedRiskIn[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const o = entry as Record<string, unknown>;
    const statement = typeof o['statement'] === 'string' ? (o['statement'] as string) : '';
    if (!statement) continue;
    const triggered = o['triggered'] === true;
    const evidence = Array.isArray(o['evidence']) ? parseEvidenceArray(o['evidence']) : [];
    out.push({ statement, triggered, evidence });
  }
  return out;
}

function parseEvidenceArray(raw: unknown[]): PillarEvaluationEvidence[] {
  const out: PillarEvaluationEvidence[] = [];
  for (const e of raw) {
    if (typeof e !== 'object' || e === null) continue;
    const o = e as Record<string, unknown>;
    if (
      typeof o['articleId'] === 'number' &&
      Number.isInteger(o['articleId']) &&
      typeof o['quote'] === 'string' &&
      (o['quote'] as string).length > 0
    ) {
      out.push({
        articleId: o['articleId'] as number,
        quote: o['quote'] as string,
      });
    }
  }
  return out;
}

function isPillarStatusRuntime(s: string): boolean {
  return s === 'Intact' || s === 'Strengthening' || s === 'Weakening' || s === 'Broken';
}

// ---------------------------------------------------------------------------
// Scoring stripper + aggregator
// ---------------------------------------------------------------------------

/**
 * Narrow each pillarScore's evidence to resolvable articleIds. If a pillar's
 * evidence is empty after stripping (but it DOES carry a status), coerce the
 * status to Intact — the agent thinks there's a change but cannot back it up,
 * so we refuse to move the pillar.
 *
 * Returns one entry per input pillarIndex we receive (may be shorter than the
 * total pillar count if the model omitted entries — those default to Intact
 * in the caller's persistedPillars mapping).
 */
function normalizePillarScoresWithStripping(
  pillarCount: number,
  scores: PillarEvaluation[],
  articleIds: Set<number>,
  log: ThesisEvalLogger,
): PillarEvaluation[] {
  const out: PillarEvaluation[] = [];
  const seen = new Set<number>();
  for (const s of scores) {
    if (s.pillarIndex < 0 || s.pillarIndex >= pillarCount) continue;
    if (seen.has(s.pillarIndex)) continue;
    seen.add(s.pillarIndex);

    const kept = s.evidence.filter((e) => articleIds.has(e.articleId));
    const droppedCount = s.evidence.length - kept.length;
    if (droppedCount > 0) {
      log.warn?.(
        {
          pillarIndex: s.pillarIndex,
          dropped: droppedCount,
        },
        '[core/thesis] pillar evidence: uncited articleIds dropped',
      );
    }

    let finalStatus = s.status;
    if (kept.length === 0 && s.status !== ThesisStatus.Intact) {
      log.warn?.(
        { pillarIndex: s.pillarIndex, originalStatus: s.status },
        '[core/thesis] pillar status coerced to Intact (no-change) — no resolvable evidence',
      );
      finalStatus = ThesisStatus.Intact;
    }

    out.push({
      pillarIndex: s.pillarIndex,
      status: finalStatus,
      evidence: kept,
    });
  }
  return out;
}

function normalizeRiskUpdatesWithStripping(
  riskCount: number,
  updates: RiskFactorUpdate[],
  articleIds: Set<number>,
  log: ThesisEvalLogger,
): RiskFactorUpdate[] {
  const out: RiskFactorUpdate[] = [];
  const seen = new Set<number>();
  for (const u of updates) {
    if (u.riskIndex < 0 || u.riskIndex >= riskCount) continue;
    if (seen.has(u.riskIndex)) continue;
    seen.add(u.riskIndex);

    const kept = u.evidence.filter((e) => articleIds.has(e.articleId));
    const droppedCount = u.evidence.length - kept.length;
    if (droppedCount > 0) {
      log.warn?.(
        { riskIndex: u.riskIndex, dropped: droppedCount },
        '[core/thesis] risk evidence: uncited articleIds dropped',
      );
    }
    // If triggered=true but no evidence survived, refuse the flip.
    if (u.triggered && kept.length === 0) {
      log.warn?.(
        { riskIndex: u.riskIndex },
        '[core/thesis] risk trigger refused — no resolvable evidence',
      );
      out.push({ riskIndex: u.riskIndex, triggered: false, evidence: [] });
      continue;
    }
    out.push({ riskIndex: u.riskIndex, triggered: u.triggered, evidence: kept });
  }
  return out;
}

/**
 * Aggregate the per-pillar statuses → one overall ThesisStatus.
 *
 *   - any pillar Broken         → Broken
 *   - majority Weakening        → Weakening
 *   - majority Strengthening    → Strengthening
 *   - otherwise                 → Intact
 *
 * "Majority" means strictly more than half of all pillars — ties go to Intact.
 */
export function aggregatePillarStatuses(
  statuses: ReadonlyArray<PillarEvaluationStatus>,
): PillarEvaluationStatus {
  if (statuses.length === 0) return 'Intact';
  if (statuses.some((s) => s === 'Broken')) return 'Broken';
  const half = statuses.length / 2;
  const weakening = statuses.filter((s) => s === 'Weakening').length;
  if (weakening > half) return 'Weakening';
  const strengthening = statuses.filter((s) => s === 'Strengthening').length;
  if (strengthening > half) return 'Strengthening';
  return 'Intact';
}

function toThesisStatusEnum(s: PillarEvaluationStatus): ThesisStatus {
  switch (s) {
    case 'Intact':
      return ThesisStatus.Intact;
    case 'Strengthening':
      return ThesisStatus.Strengthening;
    case 'Weakening':
      return ThesisStatus.Weakening;
    case 'Broken':
      return ThesisStatus.Broken;
  }
}

// ---------------------------------------------------------------------------
// Confidence + misc
// ---------------------------------------------------------------------------

function inferConfidence(citations: Citation[], articles: Article[]): Confidence {
  if (citations.length === 0) return Confidence.Low;
  const by = new Map<number, Article>();
  for (const a of articles) by.set(a.id, a);
  let hasTier1 = false;
  let allTier3 = true;
  for (const c of citations) {
    const a = by.get(c.articleId);
    const tier = a?.sourceTier ?? 2;
    if (tier === 1) hasTier1 = true;
    if (tier !== 3) allTier3 = false;
  }
  if (hasTier1) return Confidence.High;
  if (allTier3) return Confidence.Low;
  return Confidence.Medium;
}

const defaultLog: ThesisEvalLogger = {
  info: (obj, msg) => console.info(msg ?? '', obj),
  warn: (obj, msg) => console.warn(msg ?? '', obj),
  error: (obj, msg) => console.error(msg ?? '', obj),
  debug: (obj, msg) => console.debug(msg ?? '', obj),
};
