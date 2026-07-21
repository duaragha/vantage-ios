/**
 * Evening digest — 4:30pm America/Toronto, Mon–Fri.
 *
 * Window: 8h lookback (covers the trading day).
 * Content:
 *   - day recap (winners/losers from holdings)
 *   - AH earnings that just reported
 *   - tomorrow's calendar
 *   - thesis-status deltas (if any pillars weakened today based on news)
 * Tools: emit_alert, emit_thesis_update, emit_rebalance_suggestion
 */

import {
  prisma,
  utcDateOnlyRange,
  InsightKind,
  InsightStatus,
  isPassCooldownActive,
  type Insight,
  type Prisma,
} from '@vantage/db';
import {
  SONNET_MODEL,
  EMIT_ALERT_TOOL,
  EMIT_THESIS_UPDATE_TOOL,
  EMIT_REBALANCE_SUGGESTION_TOOL,
  EMIT_ROTATION_SUGGESTION_TOOL,
  type ParsedToolCall,
  type RotationSuggestionPayload,
} from '@vantage/llm';

import {
  renderArticleWindow,
  runDigestCall,
  stripOrNull,
  persistInsightFromToolCall,
  buildActionJson,
  inferDigestConfidence,
  toJsonCitations,
  type DigestContext,
  type DigestResult,
} from '../digest.js';
import {
  formatRotationPrice,
  scoreRotations,
  type RotationCandidate,
} from '../discover/rotation.js';
import { renderAccountBreakdown, renderRotationPlacement } from './accountBreakdown.js';

const SYSTEM_ADDENDUM =
  "You are preparing a post-close wrap. Summarize what happened today across the portfolio, flag any thesis weakening, and preview tomorrow's events. If rotation candidates are listed, you MAY emit `emit_rotation_suggestion` (dollar-neutral swap out of a weakening position into a dominant candidate) — cite articles for BOTH sides of the swap.";

export async function buildEveningDigest(ctx: DigestContext): Promise<DigestResult> {
  const triggeredBy = 'digest:evening';

  const tomorrow = await fetchTomorrowCalendar(
    ctx.snapshot.positions.map((p) => p.ticker),
    ctx.snapshot.snapshotAt,
    ctx.snapshot.settings.timezone,
  );

  // Phase 15 — pull rotation candidates. Fold into the same Sonnet call to
  // keep the rotation budget at max 1 extra Sonnet call per digest (in this
  // case, zero extra — rotations piggyback on the existing call).
  let rotationCandidates: RotationCandidate[] = [];
  try {
    rotationCandidates = await scoreRotations({
      threshold: 0.6,
      maxCandidates: 5,
      log: ctx.log,
    });
  } catch (err) {
    ctx.log.warn?.(
      { err: err instanceof Error ? err.message : err },
      '[core/digest/evening] rotation scorer failed — continuing without',
    );
  }

  const accountBreakdown = await renderAccountBreakdown().catch((err) => {
    ctx.log.warn?.(
      { err: err instanceof Error ? err.message : err },
      '[core/digest/evening] account breakdown failed — continuing without',
    );
    return '';
  });
  const userText = renderEveningUser(ctx, tomorrow, rotationCandidates, accountBreakdown);

  const tools =
    rotationCandidates.length > 0
      ? [
          EMIT_ALERT_TOOL,
          EMIT_THESIS_UPDATE_TOOL,
          EMIT_REBALANCE_SUGGESTION_TOOL,
          EMIT_ROTATION_SUGGESTION_TOOL,
        ]
      : [EMIT_ALERT_TOOL, EMIT_THESIS_UPDATE_TOOL, EMIT_REBALANCE_SUGGESTION_TOOL];

  const call = await runDigestCall({
    ctx,
    model: SONNET_MODEL,
    purpose: 'digest-evening',
    tools,
    systemAddendum: SYSTEM_ADDENDUM,
    userText,
    maxTokens: 4096,
  });

  const insights = await persistCalls(ctx, triggeredBy, call.toolCalls, rotationCandidates);
  const summary = renderSummary(ctx, insights, tomorrow);

  return {
    kind: 'evening',
    insights,
    summary,
    failedSources: [...ctx.failedSources],
    tokens: call.usage,
    llmCallIds: call.llmCallId ? [call.llmCallId] : [],
  };
}

async function fetchTomorrowCalendar(
  tickers: ReadonlyArray<string>,
  asOf: Date,
  timezone: string,
): Promise<Array<{ ticker: string; date: Date; headline: string; articleId: number }>> {
  if (tickers.length === 0) return [];
  const range = utcDateOnlyRange(asOf, 1, 1, timezone);
  const rows = await prisma.article.findMany({
    where: {
      source: 'finnhub_calendar',
      tickers: { hasSome: [...tickers] },
      publishedAt: { gte: range.start, lt: range.end },
    },
    orderBy: { publishedAt: 'asc' },
    take: 15,
  });
  return rows.map((r) => ({
    ticker: r.tickers[0] ?? '?',
    date: r.publishedAt,
    headline: r.headline,
    articleId: r.id,
  }));
}

function renderEveningUser(
  ctx: DigestContext,
  tomorrow: Array<{ ticker: string; date: Date; headline: string; articleId: number }>,
  rotations: ReadonlyArray<RotationCandidate>,
  accountBreakdown: string,
): string {
  const parts: string[] = [];
  parts.push('# Evening wrap run context');
  parts.push(`- Snapshot at: ${ctx.snapshot.snapshotAt.toISOString()}`);
  parts.push(`- Window: last ${ctx.windowHours}h (trading day)`);
  parts.push('');

  if (accountBreakdown) {
    parts.push(accountBreakdown);
  }

  if (tomorrow.length > 0) {
    parts.push("# Tomorrow's calendar");
    parts.push('');
    for (const e of tomorrow) {
      parts.push(
        `- [articleId: ${e.articleId}] ${e.ticker} @ ${e.date.toISOString()} — ${e.headline}`,
      );
    }
    parts.push('');
  }

  if (rotations.length > 0) {
    parts.push('# Rotation candidates (weakening holding → dominant candidate, delta ≥ 0.6)');
    parts.push('');
    for (const r of rotations) {
      parts.push(
        `- TRIM ${r.trimTicker} (thesis ${r.trimThesisStatus}, health ${r.trimHealth.toFixed(2)}) → BUY ${r.buyTicker} (score ${r.candidateScore.toFixed(2)}). Delta ${r.scoreDelta.toFixed(2)}.`,
      );
      if (r.priceSnapshots.trim !== null && r.priceSnapshots.buy !== null) {
        parts.push(
          `   Prices: TRIM ${formatRotationPrice(r, 'trim')}, BUY ${formatRotationPrice(r, 'buy')}.`,
        );
      }
      const placementLine = renderRotationPlacement(r);
      if (placementLine) parts.push(placementLine);
    }
    parts.push('');
  }

  parts.push(renderArticleWindow(ctx.articles, `Trading-day articles (last ${ctx.windowHours}h)`));

  parts.push(
    '# Instruction',
    '',
    'Summarize the trading day. Emit:',
    "- `emit_alert` for day-recap items worth the user's attention (AH earnings that just dropped, notable intraday news).",
    "- `emit_thesis_update` if a pillar weakened or strengthened based on today's news.",
    "- `emit_rebalance_suggestion` only if today's moves created a concentration problem.",
    rotations.length > 0
      ? '- `emit_rotation_suggestion` for 0-1 rotation candidates from the list above — cite BOTH sides from the article window. Dollar-neutral means the USD-equivalent value of both legs must match.'
      : '',
    'If nothing material happened, emit no tool calls.',
  );

  return parts.join('\n').replace(/\n{3,}/g, '\n\n');
}

async function persistCalls(
  ctx: DigestContext,
  triggeredBy: string,
  toolCalls: ReadonlyArray<ParsedToolCall>,
  rotations: ReadonlyArray<RotationCandidate>,
): Promise<Insight[]> {
  const out: Insight[] = [];
  const rotationByPair = new Map<string, RotationCandidate>();
  for (const r of rotations) {
    rotationByPair.set(`${r.trimTicker}->${r.buyTicker}`, r);
  }

  for (const raw of toolCalls) {
    const call = await stripOrNull(raw, ctx.log, 'evening');
    if (!call) continue;

    if (call.kind === 'emit_alert') {
      const p = call.payload;
      const insight = await persistInsightFromToolCall({
        ctx,
        call,
        triggeredBy,
        title: p.title,
        body: p.body,
        reasoning: p.reasoning,
        kind: InsightKind.Alert,
        actionJson: buildActionJson('alert', p, { source: 'digest-evening' }),
        confidence: inferDigestConfidence(p.citations, ctx.articles),
      });
      out.push(insight);
    } else if (call.kind === 'emit_thesis_update') {
      const p = call.payload;
      const insight = await persistInsightFromToolCall({
        ctx,
        call,
        triggeredBy,
        title: `Thesis ${p.newStatus}: position ${p.positionId}`,
        body: p.rationale,
        reasoning: p.rationale,
        kind: InsightKind.ThesisUpdate,
        actionJson: buildActionJson('thesis-update', p, {
          source: 'digest-evening',
        }),
        confidence: inferDigestConfidence(p.citations, ctx.articles),
      });
      out.push(insight);
    } else if (call.kind === 'emit_rebalance_suggestion') {
      const p = call.payload;
      const insight = await persistInsightFromToolCall({
        ctx,
        call,
        triggeredBy,
        title: `Rebalance: ${p.action} ${p.shares} ${p.ticker}${p.targetTicker ? ` → ${p.targetTicker}` : ''}`,
        body: p.reasoning,
        reasoning: p.reasoning,
        kind: InsightKind.Rebalance,
        actionJson: buildActionJson('rebalance', p, {
          source: 'digest-evening',
        }),
        confidence: inferDigestConfidence(p.citations, ctx.articles, p.confidence),
      });
      out.push(insight);
    } else if (call.kind === 'emit_rotation_suggestion') {
      const insight = await persistRotationCall({
        ctx,
        triggeredBy,
        source: 'digest-evening',
        payload: call.payload,
        rotationByPair,
      });
      if (insight) out.push(insight);
    }
  }
  return out;
}

async function persistRotationCall(input: {
  ctx: DigestContext;
  triggeredBy: string;
  source: string;
  payload: RotationSuggestionPayload;
  rotationByPair: Map<string, RotationCandidate>;
}): Promise<Insight | null> {
  const { ctx, triggeredBy, source, payload, rotationByPair } = input;
  const trimTicker = payload.trimTicker.toUpperCase();
  const buyTicker = payload.buyTicker.toUpperCase();

  const trimPos = ctx.snapshot.positions.find((p) => p.ticker.toUpperCase() === trimTicker);
  if (!trimPos) {
    ctx.log.warn?.(
      { trimTicker, buyTicker },
      '[core/digest/evening] rotation dropped — trim ticker not held',
    );
    return null;
  }

  const [trimBlocked, buyBlocked] = await Promise.all([
    isPassCooldownActive(trimTicker, 'trim'),
    isPassCooldownActive(buyTicker, 'buy'),
  ]);
  if (trimBlocked || buyBlocked) {
    ctx.log.info?.(
      { trimTicker, buyTicker, trimBlocked, buyBlocked },
      '[core/digest/evening] rotation dropped — cooldown active',
    );
    return null;
  }

  let trimShares = payload.trimShares;
  const held = Number(trimPos.shares);
  if (trimShares > held + 0.01) {
    ctx.log.warn?.(
      { trimTicker, requested: trimShares, held },
      '[core/digest/evening] trimShares > held — clamping',
    );
    trimShares = held;
  }

  const priced = rotationByPair.get(`${trimTicker}->${buyTicker}`);
  const placementMeta = buildRotationPlacementMeta(priced);
  const actionJson = {
    type: 'rotation',
    trimTicker,
    trimShares,
    buyTicker,
    buyShares: payload.buyShares,
    scoreDelta: payload.scoreDelta,
    ticker: buyTicker,
    shares: payload.buyShares,
    priceSnapshot: priced?.priceSnapshots.buy ?? null,
    priceCurrency: priced?.priceCurrencies.buy ?? null,
    trimPriceSnapshot: priced?.priceSnapshots.trim ?? null,
    trimPriceCurrency: priced?.priceCurrencies.trim ?? null,
    source,
    accountPlacement: placementMeta,
  } as unknown as Prisma.InputJsonValue;

  const body = placementMeta?.footer
    ? `${payload.reasoning}\n${placementMeta.footer}`
    : payload.reasoning;

  const title = `Rotate ${trimShares} ${trimTicker} → ${payload.buyShares} ${buyTicker}`;
  const insight = await prisma.insight.create({
    data: {
      kind: InsightKind.Rebalance,
      title,
      body,
      reasoning: payload.reasoning,
      citations: toJsonCitations(payload.citations),
      actionJson,
      confidence: inferDigestConfidence(payload.citations, ctx.articles),
      status: InsightStatus.New,
      triggeredBy,
    },
  });
  return insight;
}

interface RotationPlacementMeta {
  buyAccountType: string | null;
  buyAccountId: number | null;
  buyRationale: string | null;
  trimAccountId: number | null;
  trimAccountName: string | null;
  trimAccountType: string | null;
  footer: string | null;
}

function buildRotationPlacementMeta(
  candidate: RotationCandidate | undefined,
): RotationPlacementMeta | null {
  if (!candidate) return null;
  const { buyPlacement, trimAccount, buyTicker, trimTicker } = candidate;
  if (!buyPlacement && !trimAccount) return null;

  const buyAccountType = buyPlacement?.rankedAccountTypes[0] ?? null;
  const buyAccountId = buyPlacement?.bestAccountId ?? null;
  const buyRationale = buyPlacement?.rationale ?? null;

  const bits: string[] = [];
  if (buyPlacement && buyAccountType) {
    bits.push(`Buy ${buyTicker} in your ${buyAccountType} — ${buyPlacement.rationale}`);
  } else if (buyPlacement) {
    bits.push(`Buy ${buyTicker}: ${buyPlacement.rationale}`);
  }
  if (trimAccount) {
    bits.push(`Trim ${trimTicker} from your ${trimAccount.name} (${trimAccount.type})`);
  }
  const footer = bits.length > 0 ? `📍 ${bits.join(' · ')}` : null;

  return {
    buyAccountType,
    buyAccountId,
    buyRationale,
    trimAccountId: trimAccount?.id ?? null,
    trimAccountName: trimAccount?.name ?? null,
    trimAccountType: trimAccount?.type ?? null,
    footer,
  };
}

function renderSummary(
  ctx: DigestContext,
  insights: Insight[],
  tomorrow: Array<{ ticker: string; date: Date; headline: string; articleId: number }>,
): string {
  const tickers = ctx.snapshot.positions.map((p) => p.ticker).join(', ') || '—';
  const bits: string[] = [`Today's portfolio wrap for ${tickers}.`];
  if (tomorrow.length > 0) {
    const uniq = [...new Set(tomorrow.map((e) => e.ticker))];
    bits.push(`Tomorrow: ${uniq.join(', ')}.`);
  }
  if (insights.length === 0) {
    bits.push('Quiet session — nothing actionable surfaced.');
  } else {
    bits.push(`${insights.length} item${insights.length === 1 ? '' : 's'} below.`);
  }
  return bits.join(' ');
}
