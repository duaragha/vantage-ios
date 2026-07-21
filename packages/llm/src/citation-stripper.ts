/**
 * Citation stripper — defensive enforcement of the "every claim cites an
 * existing article" rule.
 *
 * Tool-use JSON schemas already require `minItems: 1`, but the model can still
 * hallucinate articleIds. We check the DB before trusting the tool call. If
 * every citation refers to a non-existent Article, reject the whole call.
 *
 * Default DB resolver uses the Prisma Article table; callers may inject a
 * custom resolver for tests / stubs.
 */

import { prisma } from '@vantage/db';
import type { ParsedToolCall, Citation } from './tools.js';

/**
 * Resolves which of the supplied articleIds actually exist. Returns the subset
 * that does. Callers override this in tests.
 */
export type ArticleExistsResolver = (
  articleIds: number[],
) => Promise<Set<number>>;

export const defaultArticleExistsResolver: ArticleExistsResolver = async (
  ids,
) => {
  if (ids.length === 0) return new Set();
  const rows = await prisma.article.findMany({
    where: { id: { in: ids } },
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
};

export interface StripOutcome<T extends ParsedToolCall> {
  /** The tool call with its citations filtered to only the ones that resolved. */
  call: T | null;
  /** citations that were present but refer to non-existent articles. */
  droppedCitations: Citation[];
}

/**
 * Which tool call kinds carry a top-level `citations: Citation[]` field.
 * `emit_initial_thesis` carries no citations (the bootstrap synthesis pass),
 * and `emit_thesis_eval` uses `overallCitations` + per-pillar evidence lists
 * that are validated by the thesis engine itself, not here. `classify_8k`
 * (Phase 17) DOES carry top-level citations and is included so the
 * stripper checks the filing-URL article + tier-1 corroborator.
 * `extract_earnings_guidance` uses `materialQuotes[]` rather than article-id
 * citations and is validated by the earnings classifier directly (verbatim
 * substring check against article bodies), not here.
 */
type CallWithCitations = Extract<
  ParsedToolCall,
  {
    kind:
      | 'emit_thesis_update'
      | 'emit_rebalance_suggestion'
      | 'emit_buy_suggestion'
      | 'emit_rotation_suggestion'
      | 'emit_alert'
      | 'classify_8k';
  }
>;

function hasTopLevelCitations(call: ParsedToolCall): call is CallWithCitations {
  return (
    call.kind === 'emit_thesis_update' ||
    call.kind === 'emit_rebalance_suggestion' ||
    call.kind === 'emit_buy_suggestion' ||
    call.kind === 'emit_rotation_suggestion' ||
    call.kind === 'emit_alert' ||
    call.kind === 'classify_8k'
  );
}

/**
 * Validate citations against the DB. If at least one citation resolves, return
 * the tool call with citations narrowed to the resolved subset. Otherwise
 * return null. Empty citations in, null out (belt-and-suspenders — the tool
 * schema already forbids this).
 *
 * Calls whose payload doesn't carry a top-level `citations` array
 * (`emit_initial_thesis`, `emit_thesis_eval`) pass through unchanged — upstream
 * validators handle those shapes.
 */
export async function stripUncitedCall<T extends ParsedToolCall>(
  call: T,
  resolver: ArticleExistsResolver = defaultArticleExistsResolver,
): Promise<StripOutcome<T>> {
  if (!hasTopLevelCitations(call)) {
    return { call, droppedCitations: [] };
  }

  const citations = call.payload.citations;
  if (!citations || citations.length === 0) {
    return { call: null, droppedCitations: [] };
  }

  const ids = citations.map((c: Citation) => c.articleId);
  const existing = await resolver(ids);

  const kept: Citation[] = [];
  const dropped: Citation[] = [];
  for (const c of citations) {
    if (existing.has(c.articleId)) kept.push(c);
    else dropped.push(c);
  }

  if (kept.length === 0) {
    return { call: null, droppedCitations: dropped };
  }

  // Return a narrowed copy so downstream consumers see only the resolved
  // citations. We shallow-copy the payload and overwrite `citations`.
  const narrowedPayload = {
    ...call.payload,
    citations: kept,
  } as T['payload'];

  return {
    call: { ...call, payload: narrowedPayload } as T,
    droppedCitations: dropped,
  };
}

/**
 * Batch-variant — applies stripUncitedCall to each call in an array, dropping
 * nulls. Useful for consuming the output of parseToolCalls().
 */
export async function stripUncitedCalls(
  calls: ReadonlyArray<ParsedToolCall>,
  resolver: ArticleExistsResolver = defaultArticleExistsResolver,
): Promise<ParsedToolCall[]> {
  const out: ParsedToolCall[] = [];
  for (const c of calls) {
    const { call } = await stripUncitedCall(c, resolver);
    if (call) out.push(call);
  }
  return out;
}
