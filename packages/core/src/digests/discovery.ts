/**
 * Discovery digest — Phase 15.
 *
 * Weekly Saturday run. Unlike morning/evening/monthly/weekly, the discovery
 * digest doesn't iterate over the portfolio — it surveys the market for names
 * the user isn't yet looking at. Output: buy suggestions on unheld names +
 * rotation suggestions out of weakening positions.
 *
 * Pipeline:
 *   1. Snapshot portfolio (same helper as other digests — we need the held
 *      ticker set for exclusion + the portfolio block for cached context).
 *   2. Pull top-10 unheld + unwatchlist DiscoveryScores with signal breakdowns.
 *   3. Run scoreRotations() for the top-5 rotation candidates.
 *   4. Build sector heatmap: for every sector, avg score change vs 7d ago.
 *   5. Build an article window of top articles (tier 1-2, last 7d) scoped to
 *      top-20 discovery tickers — hard-capped at ~20 articles to keep the
 *      prompt tight.
 *   6. Single Sonnet call with emit_buy_suggestion + emit_rotation_suggestion.
 *   7. Strip citations, persist Insights (BuySuggestion kind for buys;
 *      Rebalance kind with actionJson.type='rotation' for rotations).
 *
 * Cache discipline: the shared system prompt + the portfolio block are both
 * cached — identical to the other digests — so repeat runs in the same day
 * hit the cache.
 */

import {
  prisma,
  type Confidence,
  InsightKind,
  InsightStatus,
  isPassCooldownActive,
  latestTopN,
  type Article,
  type DiscoveryScore,
  type Insight,
  type Prisma,
  type UserSettings,
} from '@vantage/db';
import {
  callClaude,
  SONNET_MODEL,
  buildSystemPrompt,
  stripUncitedCall,
  EMIT_BUY_SUGGESTION_TOOL,
  EMIT_ROTATION_SUGGESTION_TOOL,
  type BuySuggestionPayload,
  type RotationSuggestionPayload,
  type ParsedToolCall,
} from '@vantage/llm';

import {
  snapshotPortfolio,
  inferDigestConfidence,
  toJsonCitations,
  type DigestLogger,
  type DigestTokenUsage,
  type PortfolioSnapshot,
} from '../digest.js';
import {
  formatRotationPrice,
  scoreRotations,
  type RotationCandidate,
} from '../discover/rotation.js';
import { getPriceOracle } from '../rebalance/priceOracle.js';
import { getUsdCadRate } from '../fx.js';
import { nativeAmountToUsd } from '../portfolio/valuation.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BuildDiscoveryDigestOptions {
  log?: DigestLogger;
  snapshotOverride?: PortfolioSnapshot;
}

export interface BuildDiscoveryDigestResult {
  insights: Insight[];
  summary: string;
  tokens: DigestTokenUsage;
  llmCallIds: number[];
  failedSources: string[];
}

const MAX_ARTICLES_IN_WINDOW = 20;
const TOP_DISCOVERY_COUNT = 10;

export async function buildDiscoveryDigest(
  opts: BuildDiscoveryDigestOptions = {},
): Promise<BuildDiscoveryDigestResult> {
  const log = opts.log ?? defaultLog;
  const failedSources: string[] = [];

  const snapshot = opts.snapshotOverride ?? (await snapshotPortfolio());
  const heldTickers = new Set(snapshot.positions.map((p) => p.ticker.toUpperCase()));
  const watchlistTickers = new Set(snapshot.watchlistTickers.map((t) => t.toUpperCase()));
  const excluded = [...heldTickers, ...watchlistTickers];

  // ---- 1. Top-10 discovery picks -----------------------------------------
  let discoveryPicks: DiscoveryScore[] = [];
  try {
    discoveryPicks = await latestTopN(TOP_DISCOVERY_COUNT, {
      excludeTickers: excluded,
      minScore: 0,
    });
  } catch (err) {
    log.warn?.(
      { err: err instanceof Error ? err.message : err },
      '[core/digest/discovery] latestTopN failed',
    );
    failedSources.push('discoveryScores');
  }

  // ---- 2. Rotation candidates --------------------------------------------
  let rotations: RotationCandidate[] = [];
  try {
    rotations = await scoreRotations({
      threshold: 0.6,
      maxCandidates: 5,
      log,
    });
  } catch (err) {
    log.warn?.(
      { err: err instanceof Error ? err.message : err },
      '[core/digest/discovery] scoreRotations failed',
    );
    failedSources.push('rotationScorer');
  }

  // ---- 3. Sector heatmap (7d change) -------------------------------------
  const sectorHeatmap = await buildSectorHeatmap(log);

  // ---- 4. Prompt + article window ----------------------------------------
  const windowTickers = Array.from(
    new Set([
      ...discoveryPicks.map((d) => d.ticker.toUpperCase()),
      ...rotations.flatMap((r) => [r.trimTicker, r.buyTicker]),
    ]),
  );
  const articleWindow = await fetchArticleWindow(windowTickers);
  const tickerMeta = await fetchTickerMeta(windowTickers);

  // ---- 5. Guardrail — if nothing to say, skip the LLM call ----------------
  if (discoveryPicks.length === 0 && rotations.length === 0) {
    log.info?.(
      { excluded: excluded.length },
      '[core/digest/discovery] no discovery picks or rotations — skipping LLM',
    );
    return {
      insights: [],
      summary: 'Discovery surfaced nothing worth flagging this week.',
      tokens: emptyUsage(),
      llmCallIds: [],
      failedSources,
    };
  }

  const userText = renderUserPrompt({
    discoveryPicks,
    rotations,
    sectorHeatmap,
    articles: articleWindow,
    tickerMeta,
    snapshot,
  });
  const systemAddendum = buildSystemAddendum(snapshot.settings);

  let toolCalls: ParsedToolCall[] = [];
  let usage: DigestTokenUsage = emptyUsage();
  let llmCallId = 0;
  try {
    const res = await callClaude({
      model: SONNET_MODEL,
      system: `${buildSystemPrompt()}\n\n${systemAddendum}`,
      portfolio: snapshot.portfolioBlock,
      cacheSystem: true,
      cachePortfolio: true,
      messages: [{ role: 'user', content: userText }],
      tools: [EMIT_BUY_SUGGESTION_TOOL, EMIT_ROTATION_SUGGESTION_TOOL],
      purpose: 'digest-discovery',
      maxTokens: 4096,
    });
    toolCalls = res.toolCalls;
    usage = res.usage;
    llmCallId = res.llmCallId;
  } catch (err) {
    log.error?.(
      { err: err instanceof Error ? err.message : err },
      '[core/digest/discovery] Sonnet call failed',
    );
    failedSources.push('llm:digest-discovery');
  }

  // ---- 6. Validate + persist --------------------------------------------
  const insights = await persistDiscoveryCalls({
    toolCalls,
    rotations,
    articles: articleWindow,
    log,
  });

  const summary = renderSummary({
    insightCount: insights.length,
    discoveryCount: discoveryPicks.length,
    rotationCount: rotations.length,
  });

  return {
    insights,
    summary,
    tokens: usage,
    llmCallIds: llmCallId ? [llmCallId] : [],
    failedSources,
  };
}

// ---------------------------------------------------------------------------
// Sector heatmap
// ---------------------------------------------------------------------------

interface SectorHeatRow {
  sector: string;
  nowAvgScore: number;
  weekAgoAvgScore: number;
  delta: number;
  direction: 'up' | 'down' | 'flat';
}

async function buildSectorHeatmap(log: DigestLogger): Promise<SectorHeatRow[]> {
  try {
    // Use the two most-recent compute timestamps: the latest batch and the
    // batch nearest to 7d ago. latestTopN already sliced by computedAt; here
    // we aggregate across all tickers in both windows.
    const latestAgg = await prisma.discoveryScore.aggregate({
      _max: { computedAt: true },
    });
    const latestComputed = latestAgg._max.computedAt;
    if (!latestComputed) return [];

    const weekAgoTarget = new Date(latestComputed.getTime() - 7 * 24 * 3600_000);
    // Find the DiscoveryScore batch closest to weekAgoTarget. We consider a
    // batch to be "a unique computedAt", so pick the max computedAt where
    // computedAt ≤ weekAgoTarget.
    const weekAgoRow = await prisma.discoveryScore.findFirst({
      where: { computedAt: { lte: weekAgoTarget } },
      orderBy: { computedAt: 'desc' },
      select: { computedAt: true },
    });
    const weekAgoComputed = weekAgoRow?.computedAt ?? null;

    const [nowScores, weekAgoScores] = await Promise.all([
      prisma.discoveryScore.findMany({
        where: { computedAt: latestComputed },
        select: { ticker: true, score: true },
      }),
      weekAgoComputed
        ? prisma.discoveryScore.findMany({
            where: { computedAt: weekAgoComputed },
            select: { ticker: true, score: true },
          })
        : Promise.resolve([] as Array<{ ticker: string; score: number }>),
    ]);

    if (nowScores.length === 0) return [];

    const allTickers = new Set<string>([
      ...nowScores.map((s) => s.ticker),
      ...weekAgoScores.map((s) => s.ticker),
    ]);
    const universe = await prisma.tickerUniverse.findMany({
      where: { symbol: { in: [...allTickers] } },
      select: { symbol: true, sector: true },
    });
    const sectorByTicker = new Map<string, string | null>();
    for (const u of universe) {
      sectorByTicker.set(u.symbol.toUpperCase(), u.sector ?? null);
    }

    const bucketNow = new Map<string, number[]>();
    const bucketAgo = new Map<string, number[]>();
    for (const row of nowScores) {
      const sector = sectorByTicker.get(row.ticker.toUpperCase());
      if (!sector) continue;
      const arr = bucketNow.get(sector) ?? [];
      arr.push(row.score);
      bucketNow.set(sector, arr);
    }
    for (const row of weekAgoScores) {
      const sector = sectorByTicker.get(row.ticker.toUpperCase());
      if (!sector) continue;
      const arr = bucketAgo.get(sector) ?? [];
      arr.push(row.score);
      bucketAgo.set(sector, arr);
    }

    const out: SectorHeatRow[] = [];
    for (const [sector, arr] of bucketNow.entries()) {
      const nowAvg = arr.reduce((a, b) => a + b, 0) / arr.length;
      const agoArr = bucketAgo.get(sector) ?? [];
      const agoAvg = agoArr.length > 0 ? agoArr.reduce((a, b) => a + b, 0) / agoArr.length : 0;
      const delta = nowAvg - agoAvg;
      const direction: SectorHeatRow['direction'] =
        Math.abs(delta) < 0.05 ? 'flat' : delta > 0 ? 'up' : 'down';
      out.push({
        sector,
        nowAvgScore: round3(nowAvg),
        weekAgoAvgScore: round3(agoAvg),
        delta: round3(delta),
        direction,
      });
    }
    out.sort((a, b) => b.delta - a.delta);
    return out;
  } catch (err) {
    log.warn?.(
      { err: err instanceof Error ? err.message : err },
      '[core/digest/discovery] sector heatmap failed',
    );
    return [];
  }
}

// ---------------------------------------------------------------------------
// Article window
// ---------------------------------------------------------------------------

async function fetchArticleWindow(tickers: readonly string[]): Promise<Article[]> {
  if (tickers.length === 0) return [];
  const since = new Date(Date.now() - 7 * 24 * 3600_000);
  const rows = await prisma.article.findMany({
    where: {
      tickers: { hasSome: [...tickers] },
      satireBlocked: false,
      sourceTier: { in: [1, 2] },
      publishedAt: { gte: since },
    },
    orderBy: [{ publishedAt: 'desc' }, { sourceTier: 'asc' }],
    take: MAX_ARTICLES_IN_WINDOW,
  });
  return rows;
}

async function fetchTickerMeta(
  tickers: readonly string[],
): Promise<Map<string, { name: string; sector: string | null }>> {
  if (tickers.length === 0) return new Map();
  const rows = await prisma.tickerUniverse.findMany({
    where: { symbol: { in: [...tickers] } },
    select: { symbol: true, name: true, sector: true },
  });
  const out = new Map<string, { name: string; sector: string | null }>();
  for (const r of rows) {
    out.set(r.symbol.toUpperCase(), {
      name: r.name,
      sector: r.sector,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Prompt rendering
// ---------------------------------------------------------------------------

function buildSystemAddendum(settings: UserSettings): string {
  return [
    "You are surveying the market for names worth considering that AREN'T already in the portfolio.",
    'Propose specific buys from the discovery pool and rotations out of weakening positions into stronger candidates.',
    `Caps: single position ≤ ${settings.singlePositionCapPct}%, sector ≤ ${settings.sectorCapPct}%. Monthly budget $${Number(settings.monthlyBudget).toFixed(2)} USD.`,
    'Every suggestion requires citations from the article window below.',
    'For ROTATIONS: the `citations` array MUST include at least one article supporting the TRIM side AND at least one supporting the BUY side. A rotation without a cited argument on either side is rejected.',
    'Cross-sector rotations are encouraged when DiscoveryScore delta is large — do not default to same-sector swaps out of habit.',
    'Emit 0 to ~5 tool calls total (buys + rotations combined). Quality over quantity.',
  ].join(' ');
}

interface RenderPromptInput {
  discoveryPicks: DiscoveryScore[];
  rotations: RotationCandidate[];
  sectorHeatmap: SectorHeatRow[];
  articles: Article[];
  tickerMeta: Map<string, { name: string; sector: string | null }>;
  snapshot: PortfolioSnapshot;
}

function renderUserPrompt(input: RenderPromptInput): string {
  const parts: string[] = [];
  parts.push('# Weekly market discovery run');
  parts.push(`- Snapshot: ${input.snapshot.snapshotAt.toISOString()}`);
  parts.push(`- Held: ${[...input.snapshot.positions.map((p) => p.ticker)].join(', ') || '—'}`);
  parts.push(`- Watchlist: ${input.snapshot.watchlistTickers.join(', ') || '—'}`);
  parts.push('');

  // ---- Discovery picks ---------------------------------------------------
  if (input.discoveryPicks.length > 0) {
    parts.push(`# Top ${input.discoveryPicks.length} discovery picks (unheld, unwatchlist)`);
    parts.push('');
    for (const pick of input.discoveryPicks) {
      const meta = input.tickerMeta.get(pick.ticker.toUpperCase());
      const breakdown = pick.signalBreakdown as Record<string, unknown> | null;
      const bd = renderSignalBreakdown(breakdown);
      parts.push(
        `- ${pick.ticker}${meta?.name ? ` — ${meta.name}` : ''}${meta?.sector ? ` (${meta.sector})` : ''}: score ${pick.score.toFixed(2)} · ${bd}`,
      );
    }
    parts.push('');
  }

  // ---- Rotation candidates ----------------------------------------------
  if (input.rotations.length > 0) {
    parts.push(
      `# Rotation candidates (held thesis is Weakening/Broken AND candidate dominates by ≥ 0.6)`,
    );
    parts.push('');
    for (const rot of input.rotations) {
      parts.push(
        `- TRIM ${rot.trimTicker} (thesis: ${rot.trimThesisStatus}, health ${rot.trimHealth.toFixed(2)}) → BUY ${rot.buyTicker} (discovery score ${rot.candidateScore.toFixed(2)}). Delta ${rot.scoreDelta.toFixed(2)}.`,
      );
      if (rot.priceSnapshots.trim !== null && rot.priceSnapshots.buy !== null) {
        parts.push(
          `   Prices: TRIM ${formatRotationPrice(rot, 'trim')}, BUY ${formatRotationPrice(rot, 'buy')}.`,
        );
      }
    }
    parts.push('');
  }

  // ---- Sector heatmap ----------------------------------------------------
  if (input.sectorHeatmap.length > 0) {
    parts.push('# Sector heatmap (7d avg discovery score change)');
    parts.push('');
    for (const row of input.sectorHeatmap.slice(0, 12)) {
      const arrow = row.direction === 'up' ? '↑' : row.direction === 'down' ? '↓' : '→';
      parts.push(
        `- ${row.sector}: ${arrow} ${row.delta >= 0 ? '+' : ''}${row.delta.toFixed(2)} (now ${row.nowAvgScore.toFixed(2)}, 7d ago ${row.weekAgoAvgScore.toFixed(2)})`,
      );
    }
    parts.push('');
  }

  // ---- Article window ----------------------------------------------------
  parts.push(renderArticleWindow(input.articles));

  parts.push(
    '# Instruction',
    '',
    'Pick 0-5 actionable calls across the pool:',
    '- `emit_buy_suggestion` for fresh unheld picks where the evidence supports a position.',
    '- `emit_rotation_suggestion` for weakening holdings that should rotate into a dominant candidate. Size both legs by their USD-equivalent values.',
    'Skip anything without strong tier-1 or tier-2 evidence. If nothing is actionable this week, emit zero tool calls.',
  );
  return parts.join('\n');
}

function renderSignalBreakdown(breakdown: Record<string, unknown> | null): string {
  if (!breakdown) return '(no breakdown)';
  const keys = ['news', 'earnings', 'insider', 'filings', 'momentum', 'sentiment'];
  const parts: string[] = [];
  for (const k of keys) {
    const v = breakdown[k];
    if (typeof v === 'number') {
      parts.push(`${k} ${v.toFixed(2)}`);
    }
  }
  return parts.join(' / ') || '(no breakdown)';
}

function renderArticleWindow(articles: readonly Article[]): string {
  if (articles.length === 0) {
    return '# Article window (last 7d, tier 1-2)\n\n(No qualifying articles.)\n';
  }
  const lines: string[] = [
    `# Article window (last 7d, tier 1-2, ${articles.length} articles)`,
    '',
    'Cite claims by `articleId`. Tier 1 is the strongest. Every suggestion needs ≥ 1 citation.',
    '',
  ];
  for (const a of articles) {
    const body = a.body ? a.body.slice(0, 500) : '';
    const trunc = a.body && a.body.length > 500 ? ' …[truncated]' : '';
    const tickers = a.tickers.length > 0 ? ` · tickers: ${a.tickers.join(', ')}` : '';
    lines.push(
      `[articleId: ${a.id}] (tier ${a.sourceTier} · ${a.source}${a.domain ? ` · ${a.domain}` : ''}${tickers})`,
      `  ${a.publishedAt.toISOString()} — ${a.headline}`,
    );
    if (body) lines.push(`  ${body.replace(/\s+/g, ' ').trim()}${trunc}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

interface PersistInput {
  toolCalls: ReadonlyArray<ParsedToolCall>;
  rotations: ReadonlyArray<RotationCandidate>;
  articles: ReadonlyArray<Article>;
  log: DigestLogger;
}

async function persistDiscoveryCalls(input: PersistInput): Promise<Insight[]> {
  const out: Insight[] = [];
  const triggeredBy = 'digest:discovery';
  const rotationByPair = new Map<string, RotationCandidate>();
  for (const r of input.rotations) {
    rotationByPair.set(`${r.trimTicker}->${r.buyTicker}`, r);
  }
  const oracle = getPriceOracle();
  const usdCadRate = await getUsdCadRate();

  for (const raw of input.toolCalls) {
    const { call: stripped, droppedCitations } = await stripUncitedCall(raw);
    if (droppedCitations.length > 0) {
      input.log.warn?.(
        {
          kind: raw.kind,
          dropped: droppedCitations.length,
        },
        '[core/digest/discovery] hallucinated citations stripped',
      );
    }
    if (!stripped) {
      input.log.warn?.(
        { kind: raw.kind },
        '[core/digest/discovery] all citations hallucinated — dropping tool call',
      );
      continue;
    }

    if (stripped.kind === 'emit_buy_suggestion') {
      const payload: BuySuggestionPayload = stripped.payload;
      const ticker = payload.ticker.toUpperCase();
      const blocked = await isPassCooldownActive(ticker, 'buy');
      if (blocked) {
        input.log.info?.({ ticker }, '[core/digest/discovery] buy dropped — active buy cooldown');
        continue;
      }

      const priceResult = await oracle.getLatestPrice(ticker);
      const price = priceResult?.price ?? null;
      const dollarCostUsd = priceResult
        ? payload.shares * nativeAmountToUsd(priceResult.price, priceResult.currency, usdCadRate)
        : null;

      const title = dollarCostUsd
        ? `Buy ${payload.shares} ${ticker} (~$${dollarCostUsd.toFixed(2)} USD)`
        : `Buy ${payload.shares} ${ticker}`;
      const actionJson = {
        type: 'buy',
        ticker,
        shares: payload.shares,
        priceSnapshot: price,
        priceCurrency: priceResult?.currency ?? null,
        dollarCost: dollarCostUsd,
        dollarCostUsd,
        source: 'digest-discovery',
      } as unknown as Prisma.InputJsonValue;

      const insight = await prisma.insight.create({
        data: {
          kind: InsightKind.BuySuggestion,
          title,
          body: payload.reasoning,
          reasoning: payload.reasoning,
          citations: toJsonCitations(payload.citations),
          actionJson,
          confidence: inferDigestConfidence(payload.citations, input.articles, payload.confidence),
          status: InsightStatus.New,
          triggeredBy,
        },
      });
      out.push(insight);
    } else if (stripped.kind === 'emit_rotation_suggestion') {
      const payload: RotationSuggestionPayload = stripped.payload;
      const trimTicker = payload.trimTicker.toUpperCase();
      const buyTicker = payload.buyTicker.toUpperCase();
      const [trimBlocked, buyBlocked] = await Promise.all([
        isPassCooldownActive(trimTicker, 'trim'),
        isPassCooldownActive(buyTicker, 'buy'),
      ]);
      if (trimBlocked || buyBlocked) {
        input.log.info?.(
          { trimTicker, buyTicker, trimBlocked, buyBlocked },
          '[core/digest/discovery] rotation dropped — cooldown on one or both sides',
        );
        continue;
      }

      const [trimPriceRes, buyPriceRes] = await Promise.all([
        oracle.getLatestPrice(trimTicker),
        oracle.getLatestPrice(buyTicker),
      ]);
      const priced = rotationByPair.get(`${trimTicker}->${buyTicker}`);
      const trimPrice = trimPriceRes?.price ?? priced?.priceSnapshots.trim ?? null;
      const buyPrice = buyPriceRes?.price ?? priced?.priceSnapshots.buy ?? null;
      const trimPriceCurrency = trimPriceRes?.currency ?? priced?.priceCurrencies.trim ?? null;
      const buyPriceCurrency = buyPriceRes?.currency ?? priced?.priceCurrencies.buy ?? null;

      const title = `Rotate ${payload.trimShares} ${trimTicker} → ${payload.buyShares} ${buyTicker}`;
      const actionJson = {
        type: 'rotation',
        trimTicker,
        trimShares: payload.trimShares,
        buyTicker,
        buyShares: payload.buyShares,
        scoreDelta: payload.scoreDelta,
        // Keep `ticker` set to the BUY side so the existing Bought-flow URL
        // (which reads actionJson.ticker) lands on the add-position form
        // pre-filled for the BUY leg.
        ticker: buyTicker,
        shares: payload.buyShares,
        priceSnapshot: buyPrice,
        priceCurrency: buyPriceCurrency,
        trimPriceSnapshot: trimPrice,
        trimPriceCurrency,
        source: 'digest-discovery',
      } as unknown as Prisma.InputJsonValue;

      const insight = await prisma.insight.create({
        data: {
          kind: InsightKind.Rebalance,
          title,
          body: payload.reasoning,
          reasoning: payload.reasoning,
          citations: toJsonCitations(payload.citations),
          actionJson,
          // Rotations always need a declared confidence — infer from citation
          // tiers with High cap (we don't have a model-declared confidence
          // field on the rotation tool payload; cite-weighted inference is
          // the only signal).
          confidence: inferDigestConfidence(payload.citations, input.articles),
          status: InsightStatus.New,
          triggeredBy,
        },
      });
      out.push(insight);
    } else {
      input.log.warn?.(
        { kind: stripped.kind },
        '[core/digest/discovery] unexpected tool kind — ignoring',
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

function emptyUsage(): DigestTokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheCreationTokens: 0,
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function renderSummary(input: {
  insightCount: number;
  discoveryCount: number;
  rotationCount: number;
}): string {
  const bits: string[] = [];
  bits.push(
    `Surveyed ${input.discoveryCount} unheld candidates and ${input.rotationCount} rotation pair${input.rotationCount === 1 ? '' : 's'}.`,
  );
  if (input.insightCount === 0) {
    bits.push('Nothing actionable this week.');
  } else {
    bits.push(`${input.insightCount} insight${input.insightCount === 1 ? '' : 's'} below.`);
  }
  return bits.join(' ');
}

const defaultLog: DigestLogger = {
  info: (obj, msg) => console.info(msg ?? '', obj),
  warn: (obj, msg) => console.warn(msg ?? '', obj),
  error: (obj, msg) => console.error(msg ?? '', obj),
  debug: (obj, msg) => console.debug(msg ?? '', obj),
};

// Unused marker to keep Confidence import honest for future confidence
// overrides. TypeScript will drop if unused.
export type _KeepAlive = Confidence;
