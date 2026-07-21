/**
 * 8-K classifier — Phase 17.3.
 *
 * Wraps `callClaude` with the `classify_8k` tool to get a category +
 * materiality + market direction read on a single 8-K filing. Reads the
 * filing's primary text (cached in Article.body by the EDGAR poller) plus
 * any tier-1 news articles in the same 24h window so Sonnet has corroborating
 * context.
 *
 * Strict citation enforcement:
 *   - The filing URL article id MUST appear in payload.citations.
 *   - For materialityScore ≥ 7, at least one tier-1 news article id (not
 *     the filing) must also appear.
 *   - Otherwise the call result is treated as classification-only — i.e.
 *     it's recorded for audit but NOT promoted to a Material8K MarketEvent
 *     by the caller.
 *
 * Cost-cap enforcement is the caller's responsibility (max 5 8-K
 * classifications/day per spec). This module just plumbs the call through.
 */

import { callClaude } from '../client.js';
import { stripUncitedCall } from '../citation-stripper.js';
import { CLASSIFY_8K_TOOL } from '../tools.js';
import { HAIKU_MODEL } from '../tier.js';
import type {
  EightKClassificationPayload,
  ParsedToolCall,
  Citation,
} from '../tools.js';

export interface ClassifyEightKArticle {
  /** Article.id; the value we expect to see in citations[*].articleId. */
  id: number;
  /** Domain tier classifier output (1, 2, or 3). */
  sourceTier: number;
  /** "edgar" for the filing itself; the news source name otherwise. */
  source: string;
  url: string;
  headline: string;
  /** Primary text — for the filing this is fetchFilingPrimaryText output. */
  body: string | null;
  publishedAt: Date;
}

export interface ClassifyEightKInput {
  ticker: string;
  /** The filing Article (source === 'edgar'). Body MUST be populated. */
  filing: ClassifyEightKArticle;
  /** Tier-1/2 news articles published within 24h of the filing. */
  newsArticles: ReadonlyArray<ClassifyEightKArticle>;
}

export interface ClassifyEightKResult {
  payload: EightKClassificationPayload | null;
  /**
   * True when payload is present, the filing id appears in citations, and
   * (when score ≥ 7) at least one tier-1 news citation also appears. The
   * caller emits a Material8K event only when this flag is true.
   */
  citationOk: boolean;
  /** LlmCall.id for audit. Always set, even on a failed parse. */
  llmCallId: number;
  costUsd: number;
}

function buildSystemPrompt(): string {
  return [
    'You are an SEC 8-K filing classifier for a personal equity-research agent.',
    'You read a single 8-K filing plus any tier-1 news articles published within 24h of the filing.',
    'You return ONE classify_8k tool call with category, materialityScore (1-10), summary, marketDirection, and citations.',
    '',
    'Calibration:',
    '- Reg-FD investor decks, routine officer changes, and pure boilerplate disclosures are 1-3.',
    '- Routine commercial agreements, immaterial accounting changes, and ordinary financial-condition updates are 4-6.',
    '- Major customer wins, material partnerships, FDA approvals, M&A announcements, and forced officer exits with strategic implications are 7-8.',
    '- Company-defining M&A, transformative regulatory wins, and existential litigation outcomes are 9-10.',
    '',
    'Citation rules:',
    '- Always include the filing article id in citations.',
    '- For materialityScore ≥ 7, ALSO include at least one tier-1 news article id confirming the filing impact. If no tier-1 news exists in the 24h window, you must score < 7.',
    '- Citation quotes must be VERBATIM substrings of the cited article body. The wrapper rejects any citation whose articleId is not in the provided article window.',
  ].join('\n');
}

function buildUserPrompt(input: ClassifyEightKInput): string {
  const { ticker, filing, newsArticles } = input;
  const filingTitle = filing.headline ?? '(no title)';
  const filingBody = (filing.body ?? '').slice(0, 6000);
  const lines: string[] = [];
  lines.push(`Ticker: ${ticker.toUpperCase()}`);
  lines.push('');
  lines.push(`FILING (article id ${filing.id}, ${filing.source}):`);
  lines.push(`URL: ${filing.url}`);
  lines.push(`Headline: ${filingTitle}`);
  lines.push(`Filed at: ${filing.publishedAt.toISOString()}`);
  lines.push(`Body:`);
  lines.push(filingBody.length > 0 ? filingBody : '(no body text — use headline only)');
  lines.push('');
  lines.push(`TIER-1/2 NEWS ARTICLES IN SAME 24H WINDOW (${newsArticles.length}):`);
  if (newsArticles.length === 0) {
    lines.push('(none — score must be < 7 if no corroborating tier-1 coverage)');
  } else {
    for (const a of newsArticles) {
      lines.push(`---`);
      lines.push(`Article id ${a.id}, tier ${a.sourceTier}, source ${a.source}`);
      lines.push(`URL: ${a.url}`);
      lines.push(`Headline: ${a.headline}`);
      lines.push(`Published: ${a.publishedAt.toISOString()}`);
      const body = (a.body ?? '').slice(0, 2000);
      lines.push(`Body: ${body || '(empty)'}`);
    }
  }
  lines.push('');
  lines.push(
    'Return exactly one classify_8k tool call. Cite the filing article id, plus tier-1 news ids when scoring ≥ 7.',
  );
  return lines.join('\n');
}

/**
 * Run the 8-K classifier for a single filing. Returns the parsed payload
 * (or null if the model returned no valid tool call), plus the
 * citation-ok flag the caller uses to gate Material8K event emission.
 */
export async function classifyEightK(
  input: ClassifyEightKInput,
): Promise<ClassifyEightKResult> {
  const system = buildSystemPrompt();
  const user = buildUserPrompt(input);
  const result = await callClaude({
    model: HAIKU_MODEL,
    system,
    messages: [{ role: 'user', content: user }],
    tools: [CLASSIFY_8K_TOOL],
    tool_choice: { type: 'tool', name: 'classify_8k' },
    purpose: '8k-classify',
    cacheSystem: false,
  });

  // Find the classify_8k tool call from the parsed list. Other types are
  // possible if Sonnet ignored tool_choice (rare); we only accept the
  // expected one.
  const call = result.toolCalls.find(
    (c): c is ParsedToolCall & { kind: 'classify_8k' } =>
      c.kind === 'classify_8k',
  );
  if (!call) {
    return {
      payload: null,
      citationOk: false,
      llmCallId: result.llmCallId,
      costUsd: result.costUsd,
    };
  }

  // Strip uncited articleIds against the provided article window — we don't
  // need to hit the DB because the caller passed every candidate article
  // explicitly.
  const validIds = new Set<number>([
    input.filing.id,
    ...input.newsArticles.map((a) => a.id),
  ]);
  const stripped = await stripUncitedCall(call, async (ids: number[]) => {
    return new Set(ids.filter((id) => validIds.has(id)));
  });
  const finalCall = stripped.call;
  if (!finalCall) {
    return {
      payload: null,
      citationOk: false,
      llmCallId: result.llmCallId,
      costUsd: result.costUsd,
    };
  }

  const payload = finalCall.payload;
  const filingCited = payload.citations.some(
    (c: Citation) => c.articleId === input.filing.id,
  );
  const tier1NewsCited = payload.citations.some(
    (c: Citation) => {
      if (c.articleId === input.filing.id) return false;
      const news = input.newsArticles.find((a) => a.id === c.articleId);
      return news !== undefined && news.sourceTier === 1;
    },
  );

  const citationOk =
    filingCited && (payload.materialityScore < 7 || tier1NewsCited);

  return {
    payload,
    citationOk,
    llmCallId: result.llmCallId,
    costUsd: result.costUsd,
  };
}
