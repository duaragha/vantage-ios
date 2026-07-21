/**
 * Monthly allocation digest — 9am, 1st of every month.
 *
 * Inputs:
 *   - portfolio audit (position %, sector %, vs caps)
 *   - budget = UserSettings.monthlyBudget
 *   - candidate tickers:
 *       (a) held tickers below target weight
 *       (b) watchlist tickers with strong recent catalysts
 *       (c) top discovery-scored unheld tickers
 *   - PassCooldown filter applied BEFORE LLM so we don't burn tokens on
 *     suggestions that will be rejected downstream
 * Tool: emit_buy_suggestion only.
 *
 * Post-hoc:
 *   - capValidator() rejects any suggestion that violates
 *     monthlyBudget / singlePositionCapPct / sectorCapPct
 *   - remaining-budget tracker so we don't approve two buys totaling > budget
 */

import {
  prisma,
  getLatestBarsForTickers,
  InsightKind,
  type Confidence,
  isPassCooldownActive,
  latestTopN,
  type Article,
  type Insight,
  type Position,
  type Thesis,
  type UserSettings,
} from '@vantage/db';
import {
  SONNET_MODEL,
  EMIT_BUY_SUGGESTION_TOOL,
  type BuySuggestionPayload,
  type ParsedToolCall,
} from '@vantage/llm';

import {
  renderArticleWindow,
  runDigestCall,
  stripOrNull,
  persistInsightFromToolCall,
  buildActionJson,
  inferDigestConfidence,
  capValidator,
  type BuySuggestionContext,
  type DigestContext,
  type DigestResult,
} from '../digest.js';
import { getUsdCadRate } from '../fx.js';
import {
  auditPortfolio,
  nativeAmountToUsd,
  portfolioCurrency,
  usdAmountToCad,
  type PortfolioAudit,
  type PortfolioCurrency,
} from '../portfolio/valuation.js';

export async function buildMonthlyDigest(ctx: DigestContext): Promise<DigestResult> {
  const triggeredBy = 'digest:monthly';
  const settings = ctx.snapshot.settings;

  const usdCadRate = await getUsdCadRate();
  const audit = auditPortfolio({
    positions: ctx.snapshot.positions,
    usdCadRate,
  });

  // 1. Candidate sourcing ---------------------------------------------------
  const candidates = await sourceCandidates(ctx, audit);

  // 2. Drop any candidate with an active 'buy' PassCooldown -----------------
  const cooldownFiltered: CandidateTicker[] = [];
  for (const c of candidates) {
    const blocked = await isPassCooldownActive(c.ticker, 'buy');
    if (blocked) {
      ctx.log.info?.(
        { ticker: c.ticker },
        '[core/digest/monthly] ticker skipped — active buy cooldown',
      );
      continue;
    }
    cooldownFiltered.push(c);
  }

  if (cooldownFiltered.length === 0) {
    ctx.log.info?.(
      { candidatesSourced: candidates.length },
      '[core/digest/monthly] every candidate is under cooldown — skipping LLM call',
    );
    return {
      kind: 'monthly',
      insights: [],
      summary:
        'No eligible buy candidates this month (all filtered by cooldowns or no qualifying tickers).',
      failedSources: [...ctx.failedSources],
      tokens: {
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        cacheCreationTokens: 0,
      },
      llmCallIds: [],
    };
  }

  // 3. Build prompt ---------------------------------------------------------
  const prices = await snapshotPrices(cooldownFiltered.map((c) => c.ticker));

  const systemAddendum = buildMonthlySystem(settings, audit);
  const userText = renderMonthlyUser(ctx, cooldownFiltered, audit, prices);

  // 4. Call Sonnet ----------------------------------------------------------
  const call = await runDigestCall({
    ctx,
    model: SONNET_MODEL,
    purpose: 'digest-monthly',
    tools: [EMIT_BUY_SUGGESTION_TOOL],
    systemAddendum,
    userText,
    maxTokens: 4096,
  });

  // 5. Validate + persist ---------------------------------------------------
  const insights = await validateAndPersist({
    ctx,
    triggeredBy,
    toolCalls: call.toolCalls,
    prices,
    audit,
    settings,
    candidates: cooldownFiltered,
  });

  const summary = renderSummary(ctx, insights, cooldownFiltered.length, audit);

  return {
    kind: 'monthly',
    insights,
    summary,
    failedSources: [...ctx.failedSources],
    tokens: call.usage,
    llmCallIds: call.llmCallId ? [call.llmCallId] : [],
  };
}

// ---------------------------------------------------------------------------
// Candidate sourcing
// ---------------------------------------------------------------------------

interface CandidateTicker {
  ticker: string;
  reason: 'held-below-weight' | 'watchlist-catalyst' | 'discovery-surfaced';
  sector: string | null;
  /** DiscoveryScore.score when reason='discovery-surfaced'. */
  discoveryScore?: number;
  position?: Position & { thesis: Thesis | null };
}

async function sourceCandidates(
  ctx: DigestContext,
  audit: PortfolioAudit,
): Promise<CandidateTicker[]> {
  const out: CandidateTicker[] = [];

  // (a) held tickers below target weight (below singlePositionCapPct / 2,
  // i.e. they have room to grow). We use a simple heuristic: anything under
  // half the cap is a candidate for adding.
  const halfCap = ctx.snapshot.settings.singlePositionCapPct / 2;
  const seenHeld = new Set<string>();
  for (const p of ctx.snapshot.positions) {
    const ticker = p.ticker.toUpperCase();
    if (seenHeld.has(ticker)) continue;
    seenHeld.add(ticker);
    const pct = audit.byTicker.get(ticker)?.pct ?? 0;
    if (pct < halfCap) {
      out.push({
        ticker,
        reason: 'held-below-weight',
        sector: p.sector,
        position: p,
      });
    }
  }

  // (b) watchlist tickers (preserved as a secondary bucket — user-flagged
  // names explicitly)
  for (const ticker of ctx.snapshot.watchlistTickers) {
    if (out.some((c) => c.ticker === ticker)) continue;
    out.push({ ticker, reason: 'watchlist-catalyst', sector: null });
  }

  // (c) Phase 15 — DiscoveryScores replace the old "top-5 most-mentioned
  // unheld" heuristic. Take top-10 unheld + unwatchlist by latest discovery
  // score (minScore: 0 ensures we don't surface actively-weak names).
  const held = new Set(ctx.snapshot.positions.map((p) => p.ticker.toUpperCase()));
  const watch = new Set(ctx.snapshot.watchlistTickers.map((t) => t.toUpperCase()));
  try {
    const discoveryRows = await latestTopN(10, {
      excludeTickers: [...held, ...watch],
      minScore: 0,
    });
    if (discoveryRows.length > 0) {
      // Pull sector info from TickerUniverse for display + for downstream
      // sector-cap math.
      const sectorRows = await prisma.tickerUniverse.findMany({
        where: { symbol: { in: discoveryRows.map((d) => d.ticker) } },
        select: { symbol: true, sector: true },
      });
      const sectorMap = new Map<string, string | null>();
      for (const s of sectorRows) {
        sectorMap.set(s.symbol.toUpperCase(), s.sector ?? null);
      }
      for (const d of discoveryRows) {
        if (out.some((c) => c.ticker === d.ticker)) continue;
        out.push({
          ticker: d.ticker,
          reason: 'discovery-surfaced',
          sector: sectorMap.get(d.ticker.toUpperCase()) ?? null,
          discoveryScore: d.score,
        });
      }
    }
  } catch (err) {
    ctx.log.warn?.(
      { err: err instanceof Error ? err.message : err },
      '[core/digest/monthly] DiscoveryScore lookup failed — falling back to watchlist only',
    );
  }

  return out;
}

// ---------------------------------------------------------------------------
// Price snapshots
// ---------------------------------------------------------------------------

interface MonthlyPriceSnapshot {
  price: number;
  currency: PortfolioCurrency;
}

/**
 * Best stored price for candidate tickers: a fresh LivePrice, then the latest
 * daily close, then a recent move event, then held cost basis. pollPrices has
 * already paid for the live quote, so monthly allocation does not duplicate
 * provider calls for every candidate.
 */
async function snapshotPrices(
  tickers: ReadonlyArray<string>,
): Promise<Map<string, MonthlyPriceSnapshot>> {
  const prices = new Map<string, MonthlyPriceSnapshot>();
  if (tickers.length === 0) return prices;
  const upperTickers = [...new Set(tickers.map((ticker) => ticker.toUpperCase()))];

  const [livePrices, latestBars, events, positions, universe] = await Promise.all([
    prisma.livePrice.findMany({
      where: { ticker: { in: upperTickers } },
    }),
    getLatestBarsForTickers(upperTickers),
    prisma.marketEvent.findMany({
      where: {
        kind: 'IntradayMove',
        ticker: { in: upperTickers },
        occurredAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
      orderBy: { occurredAt: 'desc' },
      take: 200,
    }),
    prisma.position.findMany({
      where: { ticker: { in: upperTickers }, closedAt: null },
    }),
    prisma.tickerUniverse.findMany({
      where: { symbol: { in: upperTickers } },
      select: { symbol: true, currency: true },
    }),
  ]);
  const currencies = new Map<string, PortfolioCurrency>();
  for (const row of universe) {
    currencies.set(row.symbol.toUpperCase(), portfolioCurrency(row.currency, row.symbol));
  }
  for (const position of positions) {
    currencies.set(
      position.ticker.toUpperCase(),
      portfolioCurrency(position.currency, position.ticker),
    );
  }

  const freshAfter = Date.now() - 10 * 60 * 1000;
  for (const row of livePrices) {
    const price = Number(row.price);
    if (row.fetchedAt.getTime() < freshAfter || !Number.isFinite(price) || price <= 0) continue;
    const ticker = row.ticker.toUpperCase();
    prices.set(ticker, {
      price,
      currency: currencies.get(ticker) ?? portfolioCurrency(null, ticker),
    });
  }

  for (const [ticker, bar] of latestBars) {
    if (prices.has(ticker)) continue;
    const price = Number(bar.close);
    if (!Number.isFinite(price) || price <= 0) continue;
    prices.set(ticker, {
      price,
      currency: currencies.get(ticker) ?? portfolioCurrency(null, ticker),
    });
  }

  // Legacy fallback for a recent event written before LivePrice existed.
  for (const e of events) {
    if (!e.ticker) continue;
    const ticker = e.ticker.toUpperCase();
    if (prices.has(ticker)) continue;
    const p = e.payload as Record<string, unknown> | null;
    if (p && typeof p === 'object') {
      const candidate = p['price'] ?? p['last'];
      if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
        prices.set(ticker, {
          price: candidate,
          currency: currencies.get(ticker) ?? portfolioCurrency(null, ticker),
        });
      }
    }
  }

  // Fill gaps from Position.avgCost (held tickers only).
  for (const p of positions) {
    const ticker = p.ticker.toUpperCase();
    if (!prices.has(ticker)) {
      prices.set(ticker, {
        price: Number(p.avgCost),
        currency: portfolioCurrency(p.currency, ticker),
      });
    }
  }
  return prices;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function buildMonthlySystem(settings: UserSettings, audit: PortfolioAudit): string {
  const budget = Number(settings.monthlyBudget);
  return [
    `You are preparing a monthly capital deployment plan.`,
    `Budget: $${budget.toFixed(2)} USD.`,
    `Caps: single position ≤${settings.singlePositionCapPct}%, sector ≤${settings.sectorCapPct}%.`,
    `Total portfolio value: $${audit.totalValueUsd.toFixed(2)} USD (C$${audit.totalValueCad.toFixed(2)} CAD).`,
    `Propose 1-3 buy suggestions with exact share counts using the latest stored market price snapshots provided in the user message.`,
    `Each must respect caps POST-purchase. Strong claims require ≥1 tier-1 citation; a buy >10% of the monthly budget without tier-1 support MUST be marked Low confidence.`,
    `Do not propose new positions that fail caps — the wrapper will reject them.`,
  ].join(' ');
}

function renderMonthlyUser(
  ctx: DigestContext,
  candidates: ReadonlyArray<CandidateTicker>,
  audit: PortfolioAudit,
  prices: Map<string, MonthlyPriceSnapshot>,
): string {
  const parts: string[] = [];
  parts.push('# Monthly allocation run');
  parts.push(`- Snapshot at: ${ctx.snapshot.snapshotAt.toISOString()}`);
  parts.push(`- Monthly budget: $${Number(ctx.snapshot.settings.monthlyBudget).toFixed(2)} USD`);
  parts.push('');

  parts.push('# Portfolio audit');
  parts.push(
    `- Total value: $${audit.totalValueUsd.toFixed(2)} USD (C$${audit.totalValueCad.toFixed(2)} CAD)`,
  );
  parts.push('## By position');
  for (const [ticker, info] of audit.byTicker) {
    parts.push(
      `- ${ticker}: $${info.valueUsd.toFixed(2)} USD (C$${info.valueCad.toFixed(2)} CAD) · ${info.pct.toFixed(1)}%${info.sector ? ` · sector ${info.sector}` : ''}`,
    );
  }
  if (audit.bySector.size > 0) {
    parts.push('## By sector');
    for (const [sector, info] of audit.bySector) {
      parts.push(`- ${sector}: ${info.pct.toFixed(1)}% ($${info.valueUsd.toFixed(2)} USD)`);
    }
  }
  parts.push('');

  parts.push('# Candidate tickers (post-cooldown filter)');
  for (const c of candidates) {
    const price = prices.get(c.ticker);
    const priceStr = price
      ? `${price.currency === 'CAD' ? 'C$' : '$'}${price.price.toFixed(2)} ${price.currency}`
      : '(no price snapshot)';
    const score =
      c.discoveryScore !== undefined ? `, discovery ${c.discoveryScore.toFixed(2)}` : '';
    const sector = c.sector ? `, sector ${c.sector}` : '';
    parts.push(`- ${c.ticker}: ${c.reason}${score}${sector} · ${priceStr}`);
  }
  parts.push('');

  parts.push(
    renderArticleWindow(
      ctx.articles,
      `Article window (last ${ctx.windowHours}h on held/watch/surfaced tickers)`,
    ),
  );

  parts.push(
    '# Instruction',
    '',
    'Emit 1-3 `emit_buy_suggestion` tool calls. For each, compute `shares` from the provided price snapshot and your chosen dollar size. Respect the caps and the budget. Cite at least one article per suggestion.',
    'If no qualifying buy exists this month, emit no tool calls.',
  );
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Validation + persistence
// ---------------------------------------------------------------------------

interface ValidateInput {
  ctx: DigestContext;
  triggeredBy: string;
  toolCalls: ReadonlyArray<ParsedToolCall>;
  prices: Map<string, MonthlyPriceSnapshot>;
  audit: PortfolioAudit;
  settings: UserSettings;
  candidates: ReadonlyArray<CandidateTicker>;
}

async function validateAndPersist(input: ValidateInput): Promise<Insight[]> {
  const { ctx, triggeredBy, toolCalls, prices, audit, settings, candidates } = input;
  const out: Insight[] = [];

  // Track running spend so two buys don't collectively blow the budget.
  let remainingBudget = Number(settings.monthlyBudget);

  // Mutable audit copy so each approved buy shifts the percentages for the
  // next validation pass.
  let running = cloneAudit(audit);

  for (const raw of toolCalls) {
    if (raw.kind !== 'emit_buy_suggestion') {
      ctx.log.warn?.({ kind: raw.kind }, '[core/digest/monthly] ignoring non-buy tool call');
      continue;
    }
    const call = await stripOrNull(raw, ctx.log, 'monthly');
    if (!call) continue;

    const payload: BuySuggestionPayload = call.payload;
    const ticker = payload.ticker.toUpperCase();
    const price = prices.get(ticker);
    const priceUsd = price ? nativeAmountToUsd(price.price, price.currency, running.usdCadRate) : 0;
    const sector =
      running.byTicker.get(ticker)?.sector ??
      candidates.find((candidate) => candidate.ticker.toUpperCase() === ticker)?.sector ??
      null;
    const buyCtx: BuySuggestionContext = {
      pricePerShare: priceUsd,
      totalPortfolioValue: running.totalValueUsd,
      sector,
      sectorCurrentValue: sector ? (running.bySector.get(sector)?.valueUsd ?? 0) : 0,
      tickerCurrentValue: running.byTicker.get(ticker)?.valueUsd ?? 0,
    };

    const violation = capValidator(payload, settings, buyCtx, remainingBudget);
    if (violation) {
      ctx.log.warn?.(
        {
          ticker: payload.ticker,
          shares: payload.shares,
          reason: violation.reason,
          detail: violation.detail,
        },
        '[core/digest/monthly] buy suggestion rejected by capValidator',
      );
      continue;
    }

    const dollarCostUsd = payload.shares * priceUsd;
    remainingBudget -= dollarCostUsd;
    running = applyBuyToAudit(
      running,
      ticker,
      dollarCostUsd,
      sector,
      price?.currency ?? portfolioCurrency(null, ticker),
    );

    const insight = await persistInsightFromToolCall({
      ctx,
      call,
      triggeredBy,
      title: `Buy ${payload.shares} ${ticker} (~$${dollarCostUsd.toFixed(2)} USD)`,
      body: payload.reasoning,
      reasoning: payload.reasoning,
      kind: InsightKind.BuySuggestion,
      actionJson: buildActionJson('buy', payload, {
        source: 'digest-monthly',
        priceSnapshot: price?.price ?? null,
        priceCurrency: price?.currency ?? null,
        dollarCost: dollarCostUsd,
        dollarCostUsd,
      }),
      confidence: inferDigestConfidence(payload.citations, ctx.articles, payload.confidence),
    });
    out.push(insight);
  }

  return out;
}

function cloneAudit(a: PortfolioAudit): PortfolioAudit {
  return {
    usdCadRate: a.usdCadRate,
    totalValueUsd: a.totalValueUsd,
    totalValueCad: a.totalValueCad,
    positions: a.positions.map((position) => ({ ...position })),
    byTicker: new Map([...a.byTicker].map(([ticker, value]) => [ticker, { ...value }])),
    bySector: new Map([...a.bySector].map(([sector, value]) => [sector, { ...value }])),
    pricesResolved: a.pricesResolved,
  };
}

function applyBuyToAudit(
  a: PortfolioAudit,
  ticker: string,
  dollarCostUsd: number,
  sector: string | null,
  currency: PortfolioCurrency,
): PortfolioAudit {
  const next = cloneAudit(a);
  const dollarCostCad = usdAmountToCad(dollarCostUsd, next.usdCadRate);
  next.totalValueUsd += dollarCostUsd;
  next.totalValueCad += dollarCostCad;
  const tickerEntry = next.byTicker.get(ticker) ?? {
    valueUsd: 0,
    valueCad: 0,
    pct: 0,
    sector,
    currency,
  };
  tickerEntry.valueUsd += dollarCostUsd;
  tickerEntry.valueCad += dollarCostCad;
  next.byTicker.set(ticker, tickerEntry);
  if (sector) {
    const sectorEntry = next.bySector.get(sector) ?? {
      valueUsd: 0,
      valueCad: 0,
      pct: 0,
    };
    sectorEntry.valueUsd += dollarCostUsd;
    sectorEntry.valueCad += dollarCostCad;
    next.bySector.set(sector, sectorEntry);
  }
  if (next.totalValueUsd > 0) {
    for (const v of next.byTicker.values()) {
      v.pct = (v.valueUsd / next.totalValueUsd) * 100;
    }
    for (const v of next.bySector.values()) {
      v.pct = (v.valueUsd / next.totalValueUsd) * 100;
    }
  }
  return next;
}

function renderSummary(
  _ctx: DigestContext,
  insights: Insight[],
  candidatesConsidered: number,
  audit: PortfolioAudit,
): string {
  const bits: string[] = [];
  bits.push(
    `Considered ${candidatesConsidered} candidate ticker${candidatesConsidered === 1 ? '' : 's'} across ${audit.byTicker.size} held position${audit.byTicker.size === 1 ? '' : 's'}.`,
  );
  if (insights.length === 0) {
    bits.push('No cap-respecting buy surfaced this month.');
  } else {
    bits.push(
      `${insights.length} buy suggestion${insights.length === 1 ? '' : 's'} passed cap validation.`,
    );
  }
  return bits.join(' ');
}

// ---------------------------------------------------------------------------
// Keep imports honest for unused-value imports in strict mode
// ---------------------------------------------------------------------------

// `Article` is used via DigestContext -> ctx.articles (structural), plus by
// inferDigestConfidence via passthrough. Keep type-only import alive.
export type _KeepAlive = Article | Confidence;
