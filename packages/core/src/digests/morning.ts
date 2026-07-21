/**
 * Morning digest — 7am America/Toronto, Mon–Fri.
 *
 * Window: 14h lookback (covers overnight + premarket).
 * Content focus:
 *   - overnight news on held tickers
 *   - pre-market movers (implicit — intraday-move MarketEvents show up as
 *     Articles if the ingestion pipeline surfaces them; we query by ticker
 *     scope, not event kind)
 *   - earnings today (Finnhub calendar Article rows have source="finnhub_calendar")
 *   - catalysts in next 5 days (same calendar source)
 * Tools: emit_alert (thesis-status flags), emit_rebalance_suggestion (if caps
 *   drift). NO emit_buy_suggestion — that's the monthly job.
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
  "You are preparing a pre-market briefing. Focus on actionable items for today's session. Do not propose new positions — only note existing-position issues, earnings on deck, and catalysts to watch. If the rotation-candidates block is non-empty, you MAY emit `emit_rotation_suggestion` (dollar-neutral swap out of a weakening position into a dominant candidate) — cite articles for BOTH sides.";

export async function buildMorningDigest(ctx: DigestContext): Promise<DigestResult> {
  const triggeredBy = 'digest:morning';

  // Earnings-today + 5-day catalysts are piggybacked into the Article table
  // by pollEarnings (source="finnhub_calendar"). We pull a slightly larger
  // window to catch tomorrow's calendar regardless of the 14h news window.
  const earningsToday = await fetchEarningsCalendar(
    ctx.snapshot.positions.map((p) => p.ticker),
    5,
    ctx.snapshot.snapshotAt,
    ctx.snapshot.settings.timezone,
  );

  // Phase 15 — pull rotation candidates so Sonnet can conditionally emit a
  // dollar-neutral swap in the same call as the standard morning output. Max
  // 1 Sonnet call per digest; we fold rotations into the existing prompt.
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
      '[core/digest/morning] rotation scorer failed — continuing without',
    );
  }

  const accountBreakdown = await renderAccountBreakdown().catch((err) => {
    ctx.log.warn?.(
      { err: err instanceof Error ? err.message : err },
      '[core/digest/morning] account breakdown failed — continuing without',
    );
    return '';
  });
  const userText = renderMorningUser(ctx, earningsToday, rotationCandidates, accountBreakdown);

  const tools =
    rotationCandidates.length > 0
      ? [EMIT_ALERT_TOOL, EMIT_REBALANCE_SUGGESTION_TOOL, EMIT_ROTATION_SUGGESTION_TOOL]
      : [EMIT_ALERT_TOOL, EMIT_REBALANCE_SUGGESTION_TOOL];

  const call = await runDigestCall({
    ctx,
    model: SONNET_MODEL,
    purpose: 'digest-morning',
    tools,
    systemAddendum: SYSTEM_ADDENDUM,
    userText,
    maxTokens: 4096,
  });

  const insights = await persistCalls(ctx, triggeredBy, call.toolCalls, rotationCandidates);
  const summary = renderSummary(ctx, insights, earningsToday);

  return {
    kind: 'morning',
    insights,
    summary,
    failedSources: [...ctx.failedSources],
    tokens: call.usage,
    llmCallIds: call.llmCallId ? [call.llmCallId] : [],
  };
}

// ---------------------------------------------------------------------------

async function fetchEarningsCalendar(
  tickers: ReadonlyArray<string>,
  lookaheadDays: number,
  asOf: Date,
  timezone: string,
): Promise<Array<{ ticker: string; date: Date; headline: string; articleId: number }>> {
  if (tickers.length === 0) return [];
  const range = utcDateOnlyRange(asOf, 0, lookaheadDays, timezone);
  const rows = await prisma.article.findMany({
    where: {
      source: 'finnhub_calendar',
      tickers: { hasSome: [...tickers] },
      publishedAt: { gte: range.start, lt: range.end },
    },
    orderBy: { publishedAt: 'asc' },
    take: 30,
  });
  return rows.map((r) => ({
    ticker: r.tickers[0] ?? '?',
    date: r.publishedAt,
    headline: r.headline,
    articleId: r.id,
  }));
}

function renderMorningUser(
  ctx: DigestContext,
  earnings: Array<{ ticker: string; date: Date; headline: string; articleId: number }>,
  rotations: ReadonlyArray<RotationCandidate>,
  accountBreakdown: string,
): string {
  const parts: string[] = [];
  parts.push(`# Morning briefing run context`);
  parts.push(`- Snapshot at: ${ctx.snapshot.snapshotAt.toISOString()}`);
  parts.push(`- Window: last ${ctx.windowHours}h of news`);
  parts.push(
    `- Caps: single ${ctx.snapshot.settings.singlePositionCapPct}%, sector ${ctx.snapshot.settings.sectorCapPct}%`,
  );
  parts.push('');

  if (accountBreakdown) {
    parts.push(accountBreakdown);
  }

  if (earnings.length > 0) {
    parts.push('# Earnings + catalyst calendar (next 5 days)');
    parts.push('');
    for (const e of earnings) {
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

  parts.push(
    renderArticleWindow(ctx.articles, `Overnight + pre-market articles (last ${ctx.windowHours}h)`),
  );

  parts.push(
    '# Instruction',
    '',
    'Review the portfolio + thesis context, the earnings/catalyst calendar, and the article window. Emit:',
    '- `emit_alert` for any thesis-status flag, earnings-on-deck with material signal, or catalyst the user needs to watch today.',
    '- `emit_rebalance_suggestion` ONLY if the overnight news materially changes concentration risk (e.g. sector shock on a >10% sector exposure).',
    rotations.length > 0
      ? '- `emit_rotation_suggestion` for 0-1 rotation candidates from the list above when the article window cites BOTH sides of the swap (weakening on the trim side, dominance on the buy side). Dollar-neutral means the USD-equivalent value of both legs must match.'
      : '',
    'Do NOT emit buy suggestions. If there is nothing actionable, emit no tool calls.',
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
    const call = await stripOrNull(raw, ctx.log, 'morning');
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
        actionJson: buildActionJson('alert', p, { source: 'digest-morning' }),
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
          source: 'digest-morning',
        }),
        confidence: inferDigestConfidence(p.citations, ctx.articles, p.confidence),
      });
      out.push(insight);
    } else if (call.kind === 'emit_rotation_suggestion') {
      const insight = await persistRotationCall({
        ctx,
        triggeredBy,
        source: 'digest-morning',
        payload: call.payload,
        rotationByPair,
      });
      if (insight) out.push(insight);
    }
    // emit_buy_suggestion and emit_thesis_update are NOT part of the morning
    // tool set — if the model tries, we ignore it (would have failed the tool
    // schema anyway).
  }
  return out;
}

/**
 * Persist a rotation suggestion as an Insight with kind=Rebalance but
 * actionJson.type='rotation'. Checks cooldowns on both sides, clamps trim
 * shares to held, and drops the call if the trim side isn't actually held.
 */
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
      '[core/digest/morning] rotation dropped — trim ticker not held',
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
      '[core/digest/morning] rotation dropped — cooldown active',
    );
    return null;
  }

  let trimShares = payload.trimShares;
  const held = Number(trimPos.shares);
  if (trimShares > held + 0.01) {
    ctx.log.warn?.(
      { trimTicker, requested: trimShares, held },
      '[core/digest/morning] trimShares > held — clamping',
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

  // Mirror the placement footer into the body so the Telegram message picks
  // it up via the same code path catalyst suggestions use.
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

/**
 * Distill a RotationCandidate's placement annotations into the actionJson
 * shape + a single Telegram footer string. Mirrors the catalyst engine's
 * `appendPlacementFooter` style so messages render consistently.
 */
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
  earnings: Array<{ ticker: string; date: Date; headline: string; articleId: number }>,
): string {
  const tickers = ctx.snapshot.positions.map((p) => p.ticker).join(', ') || '—';
  const bits: string[] = [];
  bits.push(`Portfolio under watch: ${tickers}.`);
  if (earnings.length > 0) {
    const uniq = [...new Set(earnings.map((e) => e.ticker))];
    bits.push(`Earnings/catalyst on deck: ${uniq.join(', ')}.`);
  }
  if (insights.length === 0) {
    bits.push('No actionable items surfaced from overnight news.');
  } else {
    bits.push(`${insights.length} actionable item${insights.length === 1 ? '' : 's'} below.`);
  }
  return bits.join(' ');
}
