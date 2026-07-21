/**
 * Weekly deep-dive — Sunday 8pm, Opus 4.7.
 *
 * Content:
 *   - cross-position synthesis (shared thematic/macro exposure)
 *   - diversification audit (concentration, sector drift)
 *   - stale-thesis review (theses where lastValidatedAt > 30d)
 *   - Haiku filter quality check (5% sample of articles Haiku classified
 *     as "not relevant" last week — we don't re-classify, we just surface
 *     them so the reviewer can spot obvious misses)
 * Tools: emit_alert (flagged issues), emit_thesis_update (stale-thesis refresh)
 */

import {
  prisma,
  InsightKind,
  type Article,
  type Insight,
  type Thesis,
} from '@vantage/db';
import {
  OPUS_MODEL,
  EMIT_ALERT_TOOL,
  EMIT_THESIS_UPDATE_TOOL,
  type ParsedToolCall,
} from '@vantage/llm';

import {
  renderArticleWindow,
  runDigestCall,
  stripOrNull,
  persistInsightFromToolCall,
  buildActionJson,
  inferDigestConfidence,
  type DigestContext,
  type DigestResult,
} from '../digest.js';

const SYSTEM_ADDENDUM =
  'You are conducting a weekly deep-dive. Look for patterns across positions, concentration risks, stale theses, and filter-quality issues. Output a structured review using the provided tools. Keep Alerts focused on portfolio-level issues (not single-ticker noise — that\'s the daily digest\'s job). Use emit_thesis_update for stale-thesis refresh suggestions.';

export async function buildWeeklyDigest(
  ctx: DigestContext,
): Promise<DigestResult> {
  const triggeredBy = 'digest:weekly';

  // Stale theses (not validated in 30+ days).
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600_000);
  const staleTheses = await prisma.thesis.findMany({
    where: {
      lastValidatedAt: { lt: thirtyDaysAgo },
    },
    include: { position: true },
    orderBy: { lastValidatedAt: 'asc' },
  });

  // Haiku filter quality check — pull 5% of articles from the last 7d that
  // have empty `tickers` (i.e. keyword filter discarded them). Upper-bound
  // the sample so Opus doesn't choke on context.
  const since = ctx.since;
  const irrelevantCount = await prisma.article.count({
    where: {
      publishedAt: { gte: since },
      tickers: { equals: [] },
    },
  });
  const sampleSize = Math.min(
    30,
    Math.max(0, Math.floor(irrelevantCount * 0.05)),
  );
  const irrelevantSample =
    sampleSize > 0
      ? await prisma.article.findMany({
          where: {
            publishedAt: { gte: since },
            tickers: { equals: [] },
          },
          orderBy: { publishedAt: 'desc' },
          take: sampleSize,
        })
      : [];

  const userText = renderWeeklyUser(ctx, staleTheses, irrelevantSample);

  const call = await runDigestCall({
    ctx,
    model: OPUS_MODEL,
    purpose: 'weekly-deepdive',
    tools: [EMIT_ALERT_TOOL, EMIT_THESIS_UPDATE_TOOL],
    systemAddendum: SYSTEM_ADDENDUM,
    userText,
    maxTokens: 8192,
  });

  const insights = await persistCalls(ctx, triggeredBy, call.toolCalls);
  const summary = renderSummary(ctx, insights, staleTheses.length);

  return {
    kind: 'weekly',
    insights,
    summary,
    failedSources: [...ctx.failedSources],
    tokens: call.usage,
    llmCallIds: call.llmCallId ? [call.llmCallId] : [],
  };
}

function renderWeeklyUser(
  ctx: DigestContext,
  staleTheses: ReadonlyArray<Thesis & { position: { ticker: string; id: number } }>,
  irrelevantSample: ReadonlyArray<Article>,
): string {
  const parts: string[] = [];
  parts.push('# Weekly deep-dive run');
  parts.push(`- Snapshot at: ${ctx.snapshot.snapshotAt.toISOString()}`);
  parts.push(`- Window: last ${ctx.windowHours}h`);
  parts.push('');

  if (staleTheses.length > 0) {
    parts.push('# Stale theses (not validated in 30+ days)');
    for (const t of staleTheses) {
      parts.push(
        `- ${t.position.ticker} (positionId: ${t.position.id}): last validated ${t.lastValidatedAt.toISOString()}, status ${t.status}`,
      );
    }
    parts.push('');
  }

  parts.push(
    renderArticleWindow(
      ctx.articles,
      `Portfolio-scoped article window (last ${ctx.windowHours}h)`,
    ),
  );

  if (irrelevantSample.length > 0) {
    parts.push(
      `# Filter quality sample (${irrelevantSample.length} articles Haiku classified as "not relevant" this week)`,
      '',
      'Spot-check: if any of these look like they SHOULD have been flagged for a held ticker, note it in an emit_alert with kind="filter-quality".',
      '',
    );
    for (const a of irrelevantSample) {
      parts.push(
        `[articleId: ${a.id}] ${a.publishedAt.toISOString()} · ${a.source} — ${a.headline}`,
      );
    }
    parts.push('');
  }

  parts.push(
    '# Instruction',
    '',
    'Produce a structured review. Emit:',
    '- `emit_alert` for portfolio-level concentration risk, cross-position thematic exposure, or Haiku filter-quality flags. Use kind="diversification", kind="thematic-exposure", or kind="filter-quality" as appropriate.',
    '- `emit_thesis_update` for any stale thesis where the week\'s news warrants a refresh (status change or renewed validation).',
    'Cite at least one article per finding. If there\'s nothing material to report, emit no tool calls.',
  );
  return parts.join('\n');
}

async function persistCalls(
  ctx: DigestContext,
  triggeredBy: string,
  toolCalls: ReadonlyArray<ParsedToolCall>,
): Promise<Insight[]> {
  const out: Insight[] = [];
  for (const raw of toolCalls) {
    const call = await stripOrNull(raw, ctx.log, 'weekly');
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
        actionJson: buildActionJson('alert', p, { source: 'digest-weekly' }),
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
          source: 'digest-weekly',
        }),
        confidence: inferDigestConfidence(p.citations, ctx.articles),
      });
      out.push(insight);
    }
  }
  return out;
}

function renderSummary(
  ctx: DigestContext,
  insights: Insight[],
  staleThesesCount: number,
): string {
  const bits: string[] = [];
  bits.push(
    `Weekly review across ${ctx.snapshot.positions.length} position${ctx.snapshot.positions.length === 1 ? '' : 's'}.`,
  );
  if (staleThesesCount > 0) {
    bits.push(
      `${staleThesesCount} thesis${staleThesesCount === 1 ? '' : 'es'} older than 30 days.`,
    );
  }
  if (insights.length === 0) {
    bits.push('No portfolio-level concerns surfaced.');
  } else {
    bits.push(
      `${insights.length} item${insights.length === 1 ? '' : 's'} flagged below.`,
    );
  }
  return bits.join(' ');
}
