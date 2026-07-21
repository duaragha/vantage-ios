/**
 * Earnings-guidance extractor — Phase 17.2.
 *
 * Wraps `callClaude` with the `extract_earnings_guidance` tool to read the
 * post-earnings article window (24h) and report the company's forward
 * guidance direction. Used by the EarningsBeat side of the catalyst
 * pipeline: when surprisePct ≥ 10, this fires; the caller emits an
 * `EarningsBeat` MarketEvent only when direction ≠ 'lower' AND confidence
 * ∈ {medium, high}.
 *
 * Strict citation enforcement (anti-hallucination):
 *   - Every materialQuotes entry must be a verbatim substring of one of
 *     the supplied article bodies.
 *   - The validator rejects the entire call if any quote fails the
 *     substring check.
 *
 * Cost tracking: caller bumps the daily 'earnings-guidance' counter
 * before invocation; this module does not enforce caps itself.
 */

import { callClaude } from '../client.js';
import { HAIKU_MODEL } from '../tier.js';
import type { EarningsGuidancePayload, ParsedToolCall } from '../tools.js';

export interface GuidanceArticle {
  id: number;
  sourceTier: number;
  source: string;
  url: string;
  headline: string;
  body: string | null;
  publishedAt: Date;
}

export interface ExtractGuidanceInput {
  ticker: string;
  /** Earnings event headline data (actual / estimate / surprisePct). */
  reportSummary: string;
  /** Tier 1/2 articles published within 24h of earnings actuals. */
  articles: ReadonlyArray<GuidanceArticle>;
}

export interface ExtractGuidanceResult {
  payload: EarningsGuidancePayload | null;
  /**
   * True when payload is present, materialQuotes is non-empty, and every
   * quote is a verbatim substring of one of the input article bodies.
   * Caller emits an EarningsBeat event only when this is true.
   */
  quotesValid: boolean;
  llmCallId: number;
  costUsd: number;
}

function buildSystemPrompt(): string {
  return [
    'You are an earnings-guidance reader for a personal equity-research agent.',
    'You receive (a) an earnings actuals summary and (b) the tier-1/2 article window for the 24 hours after the report.',
    'You return ONE extract_earnings_guidance tool call: { direction, confidence, materialQuotes }.',
    '',
    "direction values:",
    "- 'raise':   guidance was lifted on revenue/EPS/margins for the next quarter or year.",
    "- 'hold':    guidance was reaffirmed (range unchanged, still on track).",
    "- 'lower':   guidance was cut on any of revenue/EPS/margins/units.",
    "- 'unknown': articles do not address forward guidance, or language is genuinely ambiguous.",
    '',
    "confidence values:",
    "- 'high':   ≥1 verbatim quote from a tier-1 article that explicitly states guidance direction.",
    "- 'medium': tier-2 confirmation OR tier-1 quote with hedged language.",
    "- 'low':    tier-3-only or speculative quotes.",
    '',
    'CRITICAL: every materialQuotes entry MUST be a VERBATIM substring of one of the article bodies you were given. The wrapper rejects the call if a quote is fabricated, paraphrased, or pulled from a different article. Use short quotes (≤40 words).',
  ].join('\n');
}

function buildUserPrompt(input: ExtractGuidanceInput): string {
  const lines: string[] = [];
  lines.push(`Ticker: ${input.ticker.toUpperCase()}`);
  lines.push('');
  lines.push(`Earnings actuals summary:`);
  lines.push(input.reportSummary);
  lines.push('');
  lines.push(`Articles (${input.articles.length}):`);
  if (input.articles.length === 0) {
    lines.push('(no post-earnings articles — return direction=unknown, confidence=low)');
  } else {
    for (const a of input.articles) {
      lines.push('---');
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
    'Return exactly one extract_earnings_guidance tool call. Quote verbatim.',
  );
  return lines.join('\n');
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Verify that every quote in `quotes` appears as a substring (after light
 * whitespace normalization) of at least one article body. Returns the
 * count that passed; the caller compares to the total to decide whether
 * to keep the payload.
 */
function quotesAppearInArticles(
  quotes: ReadonlyArray<string>,
  articles: ReadonlyArray<GuidanceArticle>,
): { matched: number; total: number } {
  if (quotes.length === 0) return { matched: 0, total: 0 };
  const corpus = articles
    .map((a) => normalize(`${a.headline} ${a.body ?? ''}`))
    .join('\n\n');
  let matched = 0;
  for (const q of quotes) {
    const norm = normalize(q);
    if (norm.length === 0) continue;
    if (corpus.includes(norm)) matched++;
  }
  return { matched, total: quotes.length };
}

/**
 * Extract guidance from the post-earnings window. The result is intended
 * to be combined with the surprisePct from the earnings poller — the
 * EarningsBeat MarketEvent fires only when surprisePct ≥ 10 AND direction
 * ≠ 'lower' AND confidence ∈ {medium, high} AND quotesValid.
 */
export async function extractEarningsGuidance(
  input: ExtractGuidanceInput,
): Promise<ExtractGuidanceResult> {
  const result = await callClaude({
    model: HAIKU_MODEL,
    system: buildSystemPrompt(),
    messages: [{ role: 'user', content: buildUserPrompt(input) }],
    tools: [
      {
        // Re-import here to avoid circular module load — pulled from tools.ts
        // by the LLM index. Equivalent to EXTRACT_EARNINGS_GUIDANCE_TOOL.
        name: 'extract_earnings_guidance',
        description: 'Returns the company forward-guidance direction.',
        input_schema: {
          type: 'object',
          properties: {
            direction: {
              type: 'string',
              enum: ['raise', 'hold', 'lower', 'unknown'],
            },
            confidence: {
              type: 'string',
              enum: ['low', 'medium', 'high'],
            },
            materialQuotes: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
            },
          },
          required: ['direction', 'confidence', 'materialQuotes'],
          additionalProperties: false,
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'extract_earnings_guidance' },
    purpose: 'earnings-guidance',
  });

  const call = result.toolCalls.find(
    (c): c is ParsedToolCall & { kind: 'extract_earnings_guidance' } =>
      c.kind === 'extract_earnings_guidance',
  );
  if (!call) {
    return {
      payload: null,
      quotesValid: false,
      llmCallId: result.llmCallId,
      costUsd: result.costUsd,
    };
  }

  const payload = call.payload;
  const { matched, total } = quotesAppearInArticles(
    payload.materialQuotes,
    input.articles,
  );
  // Validation: every quote must appear in some article body. We don't
  // require ALL articles to host a quote — just that no fabrications slip
  // through.
  const quotesValid = total > 0 && matched === total;

  return {
    payload,
    quotesValid,
    llmCallId: result.llmCallId,
    costUsd: result.costUsd,
  };
}
