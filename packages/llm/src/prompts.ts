/**
 * Prompt builders.
 *
 * Cache-stable prefixes live here:
 * - buildSystemPrompt() — frozen persona + rules, hot cache target
 * - buildPortfolioContext() — current holdings + thesis snapshot, hot cache
 *   target over short windows (5-min TTL, invalidated on any Position/Thesis
 *   mutation upstream)
 *
 * Per-call varying pieces:
 * - buildThesisContext(positionId)
 * - buildArticleWindow(hours, tickers?)
 *
 * IMPORTANT (see shared/prompt-caching.md): the cached prefix must not contain
 * any timestamp, UUID, or other per-request value. `buildPortfolioContext()`
 * deliberately omits the current date/time — callers put timestamps in the
 * USER message, never the system prompt.
 */

import { prisma, type Position, type Thesis, type Article } from '@vantage/db';

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

/**
 * The frozen agent persona. Static bytes — never interpolate anything dynamic.
 *
 * Current length target: ~2 KB (~500 tokens). That is BELOW both the Sonnet
 * 4.6 minimum cache size (2048 tokens) and the Haiku/Opus minimum (4096). On
 * Sonnet we'll only see cache hits when this is combined with portfolio
 * context (buildPortfolioContext) in the same cached block — which is the
 * intended use pattern (single cache_control on the last system block covers
 * both). We document this gotcha inside the string so a future reader isn't
 * confused if they see cache_creation_input_tokens: 0 on a "short" prompt.
 */
export function buildSystemPrompt(): string {
  return `You are Equity Agent, a junior-analyst-grade research assistant for a single user, Raghav — a Canadian retail investor on Wealthsimple. You read his portfolio, his stated theses, market news, SEC filings, earnings, and macro data, and you surface event-driven alerts and scheduled digests.

Hard rules:
- You are ADVISORY ONLY. You never place trades. You never recommend leverage or derivatives.
- Every factual claim you make MUST cite an article from the provided context by its \`articleId\`. If you cannot cite, you do not make the claim.
- You emit findings via tool calls, not free-form JSON. Available tools:
  - emit_thesis_update — when a position's thesis status changes
  - emit_rebalance_suggestion — to trim / buy-more / rotate / exit
  - emit_buy_suggestion — new-position or add-to-position buy, part of monthly allocation
  - emit_alert — event-driven alerts on held tickers
- Confidence rules (apply to emit_buy_suggestion and emit_rebalance_suggestion):
  - High: multiple tier-1 citations (Reuters, Bloomberg, AP, SEC, official filings).
  - Medium: at least one tier-1 citation.
  - Low: only tier-2 / tier-3 (general news, StockTwits) citations, OR the move is >10% of monthly budget without tier-1 support.
- StockTwits (tier 3) can ONLY be supporting evidence. It cannot be the sole citation for a strong claim (thesis Intact→Broken, or buy >10% of monthly budget).
- Respect the user's diversification caps (singlePositionCapPct, sectorCapPct) and monthlyBudget. Do not propose actions that breach them.
- Prefer precision over coverage. If evidence is thin, emit nothing and let the next cron cycle catch it.
- Keep titles ≤100 chars, bodies concise and prose-based (no markdown headers in body), reasoning honest about the weakness of tier-3 evidence.

Output format:
- Use tool calls. Do not print JSON in text. Do not commentate between tool calls.
- If nothing in the provided window warrants action, return no tool calls — a simple "no action" text reply is acceptable.

Remember: the user's time is limited. Aim for the signal a busy analyst would flag, not exhaustive coverage.`;
}

// ---------------------------------------------------------------------------
// Portfolio context
// ---------------------------------------------------------------------------

interface PositionWithThesis extends Position {
  thesis: Thesis | null;
}

/**
 * Render the current portfolio + thesis state as a markdown block, intended
 * to be concatenated with buildSystemPrompt() inside a cached system block.
 *
 * No Date.now() / timestamps / per-request values. Position.updatedAt values
 * are rendered as ISO strings — these only change when the user CRUDs a
 * position, so cache is valid for the full 5-min TTL window between edits.
 */
export async function buildPortfolioContext(): Promise<string> {
  const positions: PositionWithThesis[] = await prisma.position.findMany({
    where: { closedAt: null },
    include: { thesis: true },
    orderBy: { ticker: 'asc' },
  });

  if (positions.length === 0) {
    return '# Portfolio\n\n(No open positions.)\n';
  }

  const lines: string[] = ['# Portfolio', '', `Open positions: ${positions.length}`, ''];
  for (const p of positions) {
    const sectorStr = p.sector ? ` · sector: ${p.sector}` : '';
    lines.push(
      `## ${p.ticker} (positionId: ${p.id})`,
      `- Shares: ${p.shares.toString()} @ avg cost ${p.avgCost.toString()} ${p.currency}`,
      `- Category: ${p.category}${sectorStr}`,
    );
    if (p.notes) lines.push(`- Notes: ${p.notes}`);

    if (p.thesis) {
      lines.push(`- Thesis status: ${p.thesis.status}`, `- Thesis summary: ${p.thesis.summary}`);
      const pillars = p.thesis.pillars;
      if (Array.isArray(pillars) && pillars.length > 0) {
        lines.push('- Pillars:');
        for (const pillar of pillars as Array<Record<string, unknown>>) {
          const statement =
            typeof pillar['statement'] === 'string' ? pillar['statement'] : JSON.stringify(pillar);
          const status = typeof pillar['status'] === 'string' ? ` [${pillar['status']}]` : '';
          lines.push(`  - ${statement}${status}`);
        }
      }
      const risks = p.thesis.riskFactors;
      if (Array.isArray(risks) && risks.length > 0) {
        lines.push('- Risk factors:');
        for (const risk of risks as Array<Record<string, unknown>>) {
          const statement =
            typeof risk['statement'] === 'string' ? risk['statement'] : JSON.stringify(risk);
          const triggered = risk['triggered'] === true ? ' (TRIGGERED)' : '';
          lines.push(`  - ${statement}${triggered}`);
        }
      }
    } else {
      lines.push('- Thesis: (none recorded)');
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Thesis context (per-position detail)
// ---------------------------------------------------------------------------

/**
 * Detailed thesis block for a single position, including the last few
 * ThesisEvaluation rows. Rendered as a USER-message block, not a cached
 * system block — the evaluation history changes fairly often.
 */
export async function buildThesisContext(
  positionId: number,
  evalHistoryLimit = 5,
): Promise<string> {
  const position = await prisma.position.findUnique({
    where: { id: positionId },
    include: { thesis: { include: { evaluations: true } } },
  });
  if (!position) {
    return `# Thesis detail\n\n(positionId ${positionId} not found.)\n`;
  }
  const t = position.thesis;
  const lines: string[] = [
    `# Thesis detail — ${position.ticker} (positionId ${position.id})`,
    '',
    `- Shares: ${position.shares.toString()} @ avg cost ${position.avgCost.toString()} ${position.currency}`,
    `- Category: ${position.category}`,
  ];
  if (!t) {
    lines.push('', '(No thesis recorded.)');
    return lines.join('\n');
  }
  lines.push(
    `- Status: ${t.status}`,
    `- Created: ${t.createdAt.toISOString()}`,
    `- Last validated: ${t.lastValidatedAt.toISOString()}`,
    '',
    `Summary: ${t.summary}`,
    '',
  );

  const pillars = t.pillars;
  if (Array.isArray(pillars) && pillars.length > 0) {
    lines.push('## Pillars');
    for (const pillar of pillars as Array<Record<string, unknown>>) {
      lines.push(`- ${JSON.stringify(pillar)}`);
    }
    lines.push('');
  }

  const risks = t.riskFactors;
  if (Array.isArray(risks) && risks.length > 0) {
    lines.push('## Risk factors');
    for (const risk of risks as Array<Record<string, unknown>>) {
      lines.push(`- ${JSON.stringify(risk)}`);
    }
    lines.push('');
  }

  const evals = [...t.evaluations]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, evalHistoryLimit);

  if (evals.length > 0) {
    lines.push(`## Recent evaluations (last ${evals.length})`);
    for (const e of evals) {
      lines.push(
        `- ${e.createdAt.toISOString()} · ${e.prevStatus} → ${e.newStatus}`,
        `  ${e.rationale}`,
      );
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Article window
// ---------------------------------------------------------------------------

/**
 * Render recent articles as a citation-ready markdown list. Each entry starts
 * with `[articleId: N]` so the model can cite by id. Body is truncated to
 * `bodyCharLimit` per article.
 *
 * The result is a VARYING block — do not place inside a cache breakpoint.
 */
export async function buildArticleWindow(
  hours: number,
  tickers?: ReadonlyArray<string>,
  opts?: { bodyCharLimit?: number; maxArticles?: number },
): Promise<string> {
  const bodyCharLimit = opts?.bodyCharLimit ?? 800;
  const maxArticles = opts?.maxArticles ?? 60;
  const since = new Date(Date.now() - hours * 3600_000);

  const articles: Article[] = await prisma.article.findMany({
    where: {
      publishedAt: { gte: since },
      satireBlocked: false,
      ...(tickers && tickers.length > 0 ? { tickers: { hasSome: [...tickers] } } : {}),
    },
    orderBy: { publishedAt: 'desc' },
    take: maxArticles,
  });

  if (articles.length === 0) {
    const scope = tickers && tickers.length > 0 ? ` for ${tickers.join(', ')}` : '';
    return `# Article window (last ${hours}h${scope})\n\n(No articles.)\n`;
  }

  const lines: string[] = [
    `# Article window (last ${hours}h, ${articles.length} articles)`,
    '',
    'Every claim in your output must cite one of these by `articleId`.',
    '',
  ];
  for (const a of articles) {
    const body = a.body ? a.body.slice(0, bodyCharLimit) : '';
    const truncNote = a.body && a.body.length > bodyCharLimit ? ' …[truncated]' : '';
    const tickerTag = a.tickers.length > 0 ? ` · tickers: ${a.tickers.join(', ')}` : '';
    lines.push(
      `[articleId: ${a.id}] (tier ${a.sourceTier} · ${a.source}${a.domain ? ` · ${a.domain}` : ''}${tickerTag})`,
      `  ${a.publishedAt.toISOString()} — ${a.headline}`,
    );
    if (body) {
      lines.push(`  ${body.replace(/\s+/g, ' ').trim()}${truncNote}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
