/**
 * Structured-output tool definitions for the agent.
 *
 * We use Anthropic tool-use as a structured-output mechanism: Sonnet/Opus emits
 * one of four tool calls to return its finding. This gives us strict JSON
 * schemas on the way out + a clean place to enforce non-empty citations and
 * confidence levels.
 *
 * IMPORTANT: every tool requires a non-empty `citations` array. If the model
 * emits a tool call without citations, citation-stripper.ts rejects it. The
 * tool description repeats this rule so the model sees it inline.
 *
 * Schemas are hand-written JSON Schema (not Zod) because the tool_use surface
 * expects raw schemas and we want to keep this package dependency-light.
 */

import type Anthropic from '@anthropic-ai/sdk';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type ThesisStatus = 'Intact' | 'Strengthening' | 'Weakening' | 'Broken';
export type Confidence = 'Low' | 'Medium' | 'High';
export type RebalanceAction = 'trim' | 'buy' | 'rotate' | 'exit';

export interface Citation {
  articleId: number;
  quote: string;
}

// Tool-emitted payload types (what the model returns after JSON parse).
export interface ThesisUpdatePayload {
  positionId: number;
  newStatus: ThesisStatus;
  rationale: string;
  citations: Citation[];
}

export interface RebalanceSuggestionPayload {
  action: RebalanceAction;
  ticker: string;
  shares: number;
  targetTicker?: string;
  reasoning: string;
  citations: Citation[];
  confidence: Confidence;
}

/**
 * Catalyst event kinds the catalyst engine surfaces. 'mixed' covers buys
 * triggered by 2+ kinds in conjunction (the model picks the dominant one).
 * Phase 17.5 — extends the existing emit_buy_suggestion tool with
 * `catalystKind` + `conjunctionLevel` fields so catalyst-driven buys land
 * with the same shape as monthly-allocation buys but carry the extra
 * surface metadata for the dashboard badge + sort path.
 */
export type CatalystKind =
  | 'InsiderCluster'
  | 'EarningsBeat'
  | 'Material8K'
  | 'AnalystUpgrade'
  | 'mixed';

export type ConjunctionLevel = 1 | 2 | 3;

export interface BuySuggestionPayload {
  ticker: string;
  shares: number;
  reasoning: string;
  citations: Citation[];
  confidence: Confidence;
  /**
   * Optional catalyst metadata. Present when the suggestion was emitted by
   * the catalyst engine; absent for monthly-allocation buys.
   */
  catalystKind?: CatalystKind;
  conjunctionLevel?: ConjunctionLevel;
}

/**
 * Rotation suggestion — Phase 15.
 *
 * Dollar-neutral: sell TRIM to fund BUY. The tool is separate from
 * `emit_rebalance_suggestion` (which is cap-driven) so Sonnet can articulate
 * the "X is weakening, Y ranks higher on the discovery score" argument
 * cleanly — and so the wrapper can apply rotation-specific validation
 * (both-sides cooldown, dollar-neutrality, both-sides citations).
 */
export interface RotationSuggestionPayload {
  trimTicker: string;
  trimShares: number;
  buyTicker: string;
  buyShares: number;
  scoreDelta: number;
  reasoning: string;
  citations: Citation[];
}

export interface AlertPayload {
  kind: string;
  title: string;
  body: string;
  reasoning: string;
  citations: Citation[];
}

export interface InitialThesisPillar {
  statement: string;
}

export interface InitialThesisRiskFactor {
  statement: string;
}

export interface InitialThesisPayload {
  summary: string;
  pillars: InitialThesisPillar[];
  riskFactors: InitialThesisRiskFactor[];
}

/**
 * Thesis-evaluation tool payload — NOT one of the shared Anthropic.Tool
 * structured-output paths because it does not carry top-level citations (each
 * pillar carries its own evidence list instead). Kept as a named type so the
 * thesis engine and the tool schema stay in sync.
 */
export type PillarEvaluationStatus =
  | 'Intact'
  | 'Strengthening'
  | 'Weakening'
  | 'Broken';

export interface PillarEvaluationEvidence {
  articleId: number;
  quote: string;
}

export interface PillarEvaluation {
  pillarIndex: number;
  status: PillarEvaluationStatus;
  evidence: PillarEvaluationEvidence[];
}

export interface RiskFactorUpdate {
  riskIndex: number;
  triggered: boolean;
  evidence: PillarEvaluationEvidence[];
}

export interface ThesisEvalPayload {
  pillarScores: PillarEvaluation[];
  riskFactorUpdates: RiskFactorUpdate[];
  overallStatus: PillarEvaluationStatus;
  overallRationale: string;
  overallCitations: Citation[];
}

export type ToolName =
  | 'emit_thesis_update'
  | 'emit_rebalance_suggestion'
  | 'emit_buy_suggestion'
  | 'emit_rotation_suggestion'
  | 'emit_alert'
  | 'emit_initial_thesis'
  | 'emit_thesis_eval'
  // Phase 17 — catalyst engine classifiers.
  | 'extract_earnings_guidance'
  | 'classify_8k';

// ---------------------------------------------------------------------------
// Phase 17 — catalyst engine tool payloads
// ---------------------------------------------------------------------------

export type GuidanceDirection = 'raise' | 'hold' | 'lower' | 'unknown';
export type GuidanceConfidence = 'low' | 'medium' | 'high';

/**
 * `extract_earnings_guidance` — fired after a >=10% surprise to surface the
 * real signal: forward guidance direction. Strict citation requirement —
 * the wrapper drops the call if `materialQuotes` is empty or no quote
 * resolves to an article in the post-earnings window.
 */
export interface EarningsGuidancePayload {
  direction: GuidanceDirection;
  confidence: GuidanceConfidence;
  /**
   * Verbatim quotes from earnings articles that support the direction
   * call. The runtime stripper validates that every quote appears in a
   * tier-1/2 article body — fabricated quotes get the call dropped.
   */
  materialQuotes: string[];
}

export type EightKCategory =
  | 'contract'
  | 'mna'
  | 'fda_regulatory'
  | 'officer_change'
  | 'reg_fd'
  | 'other';

export type EightKMarketDirection = 'bullish' | 'bearish' | 'neutral';

/**
 * `classify_8k` — Sonnet's read on a fresh 8-K. Materiality 1-10 with the
 * spec convention that ≥7 is alert-worthy AND requires at least one tier-1
 * news citation corroborating the read. The wrapper enforces both checks.
 */
export interface EightKClassificationPayload {
  /** 8-K item codes the filing covers, e.g. ["1.01","8.01"]. */
  items: string[];
  category: EightKCategory;
  /** 1 (irrelevant boilerplate) → 10 (game-changing M&A / FDA). */
  materialityScore: number;
  summary: string;
  marketDirection: EightKMarketDirection;
  /**
   * Citations. The filing URL article MUST appear here for any score; one
   * tier-1 corroborating news article is REQUIRED for scores ≥ 7.
   */
  citations: Citation[];
}

// Discriminated union of parsed tool calls. `kind` echoes the tool name so
// downstream code can switch once and get narrowed payload types.
export type ParsedToolCall =
  | { kind: 'emit_thesis_update'; id: string; payload: ThesisUpdatePayload }
  | {
      kind: 'emit_rebalance_suggestion';
      id: string;
      payload: RebalanceSuggestionPayload;
    }
  | { kind: 'emit_buy_suggestion'; id: string; payload: BuySuggestionPayload }
  | {
      kind: 'emit_rotation_suggestion';
      id: string;
      payload: RotationSuggestionPayload;
    }
  | { kind: 'emit_alert'; id: string; payload: AlertPayload }
  | { kind: 'emit_initial_thesis'; id: string; payload: InitialThesisPayload }
  | { kind: 'emit_thesis_eval'; id: string; payload: ThesisEvalPayload }
  | {
      kind: 'extract_earnings_guidance';
      id: string;
      payload: EarningsGuidancePayload;
    }
  | { kind: 'classify_8k'; id: string; payload: EightKClassificationPayload };

// ---------------------------------------------------------------------------
// JSON-schema helpers
// ---------------------------------------------------------------------------

const citationsSchema = {
  type: 'array' as const,
  description:
    'Evidence for the claim. MUST be non-empty. Each entry is an articleId ' +
    'from the context and a verbatim quote from that article. The wrapper ' +
    'strips any tool call with an empty or unresolvable citations array.',
  minItems: 1,
  items: {
    type: 'object' as const,
    properties: {
      articleId: {
        type: 'integer' as const,
        description:
          'The Article.id from the provided context. Must reference an article that actually appears in the context window.',
      },
      quote: {
        type: 'string' as const,
        description:
          'A short verbatim quote from the referenced article that directly supports the claim.',
        minLength: 1,
      },
    },
    required: ['articleId', 'quote'],
    additionalProperties: false,
  },
};

// ---------------------------------------------------------------------------
// Tool definitions (Anthropic.Tool[])
// ---------------------------------------------------------------------------

/**
 * Re-exported as a named alias so packages that don't depend on the
 * Anthropic SDK (e.g. @vantage/core) can still type tool arrays passed
 * into the llm package.
 */
export type ToolDefinition = Anthropic.Tool;

export const EMIT_THESIS_UPDATE_TOOL: Anthropic.Tool = {
  name: 'emit_thesis_update',
  description:
    'Record that a position thesis has changed status. Use when material news, ' +
    'filings, earnings, or macro moves alter the validity of the thesis pillars. ' +
    'ALWAYS include at least one citation backed by an article from the context.',
  input_schema: {
    type: 'object',
    properties: {
      positionId: {
        type: 'integer',
        description: 'The Position.id whose thesis is being updated.',
      },
      newStatus: {
        type: 'string',
        enum: ['Intact', 'Strengthening', 'Weakening', 'Broken'],
        description: 'The new ThesisStatus.',
      },
      rationale: {
        type: 'string',
        description:
          'A concise explanation of why the thesis changed, tying each pillar back to the evidence.',
        minLength: 1,
      },
      citations: citationsSchema,
    },
    required: ['positionId', 'newStatus', 'rationale', 'citations'],
    additionalProperties: false,
  },
};

export const EMIT_REBALANCE_SUGGESTION_TOOL: Anthropic.Tool = {
  name: 'emit_rebalance_suggestion',
  description:
    'Suggest trimming, buying more, rotating, or fully exiting a position. ' +
    "Use only when the portfolio is out of balance (sector/single-position caps) or a thesis has materially weakened. Respect the user's diversification caps. ALWAYS cite at least one article.",
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['trim', 'buy', 'rotate', 'exit'],
        description:
          '"trim": reduce shares. "buy": add shares to an existing position. "rotate": sell X, buy Y (specify targetTicker). "exit": close the entire position.',
      },
      ticker: {
        type: 'string',
        description:
          'The primary ticker being acted upon. For "rotate" this is the ticker being sold.',
      },
      shares: {
        type: 'number',
        description:
          'Share count (or fractional shares). For "exit" this can mirror the full current position size.',
      },
      targetTicker: {
        type: 'string',
        description:
          'Only for action="rotate": the ticker to rotate INTO. Omit for trim/buy/exit.',
      },
      reasoning: {
        type: 'string',
        description:
          'Concrete reasoning tied to the citations and the caps being enforced.',
        minLength: 1,
      },
      citations: citationsSchema,
      confidence: {
        type: 'string',
        enum: ['Low', 'Medium', 'High'],
        description:
          'Confidence level. Downgrade to Low if zero tier-1 citations, or if the move exceeds 10% of monthly budget without tier-1 corroboration.',
      },
    },
    required: ['action', 'ticker', 'shares', 'reasoning', 'citations', 'confidence'],
    additionalProperties: false,
  },
};

export const EMIT_BUY_SUGGESTION_TOOL: Anthropic.Tool = {
  name: 'emit_buy_suggestion',
  description:
    'Suggest opening a new position or adding to an existing one. ' +
    'The wrapper verifies against the user\'s monthlyBudget, singlePositionCapPct, and sectorCapPct caps — DO NOT exceed them. Any suggestion >10% of the monthly budget MUST have at least one tier-1 citation or its confidence MUST be Low. ALWAYS cite at least one article. ' +
    'When this call is part of the catalyst engine (a catalyst MarketEvent + corroborating evidence is in the prompt), populate `catalystKind` (InsiderCluster | EarningsBeat | Material8K | AnalystUpgrade | mixed) and `conjunctionLevel` (1 = single signal, 2 = co-occurring signals or single-signal + tier-1 corroboration, 3 = full triplet across insider/earnings/8-K). Omit both fields for plain monthly-allocation buys.',
  input_schema: {
    type: 'object',
    properties: {
      ticker: {
        type: 'string',
        description: 'The ticker to buy.',
      },
      shares: {
        type: 'number',
        description:
          'Share count. Computed from a target dollar amount and latest price snapshot.',
      },
      reasoning: {
        type: 'string',
        description:
          'Why this ticker, why now, and why this size (tying back to caps and thesis if an existing position).',
        minLength: 1,
      },
      citations: citationsSchema,
      confidence: {
        type: 'string',
        enum: ['Low', 'Medium', 'High'],
        description:
          'Confidence. Must be Low if no tier-1 citation supports the claim when the buy is >10% of monthly budget.',
      },
      catalystKind: {
        type: 'string',
        enum: [
          'InsiderCluster',
          'EarningsBeat',
          'Material8K',
          'AnalystUpgrade',
          'mixed',
        ],
        description:
          'Optional. Set ONLY when this call is part of the catalyst engine. Pick the dominant signal driving the buy; use "mixed" when 2+ kinds co-occur and no single one dominates.',
      },
      conjunctionLevel: {
        type: 'integer',
        enum: [1, 2, 3],
        description:
          'Optional. Companion to catalystKind. 1 = single signal, 2 = at least one corroborating signal (another catalyst kind OR tier-1 news), 3 = full triplet of insider + earnings + 8-K kinds.',
      },
    },
    required: ['ticker', 'shares', 'reasoning', 'citations', 'confidence'],
    additionalProperties: false,
  },
};

/**
 * emit_rotation_suggestion — Phase 15.
 *
 * Dollar-neutral rotation: sell N shares of TRIM_TICKER (whose thesis has
 * weakened) and use proceeds to buy M shares of BUY_TICKER (which ranks
 * significantly higher on current market discovery signals).
 *
 * CITATION RULE (documented for the model): the `citations` array MUST
 * include evidence supporting BOTH sides of the rotation — at least one
 * article arguing the trim (why TRIM's thesis is weakening) and at least one
 * article arguing the buy (why BUY ranks higher). The wrapper does not
 * currently verify side-balance at the schema level, but citations land in
 * the strip-and-confidence path — downstream validators that pull the
 * per-side evidence will surface the rotation as Low confidence if the
 * model didn't supply citations for both sides.
 */
export const EMIT_ROTATION_SUGGESTION_TOOL: Anthropic.Tool = {
  name: 'emit_rotation_suggestion',
  description:
    'Propose a rotation: trim N shares of TRIM_TICKER (whose thesis has weakened) and use proceeds to buy M shares of BUY_TICKER (which ranks significantly higher on current market signals). Cite articles supporting BOTH sides — one quote arguing the trim, one quote arguing the buy. Dollar-neutral: trim_shares × trim_price ≈ buy_shares × buy_price. Use only when the held thesis is Weakening or Broken AND the candidate\'s discovery score beats the held ticker\'s position health by ≥ 0.6.',
  input_schema: {
    type: 'object',
    properties: {
      trimTicker: {
        type: 'string',
        description: 'Ticker of the held position being reduced.',
      },
      trimShares: {
        type: 'number',
        description:
          'Share count to trim. Must be ≤ current position shares (wrapper clamps to held).',
      },
      buyTicker: {
        type: 'string',
        description: 'Ticker being rotated INTO.',
      },
      buyShares: {
        type: 'number',
        description:
          'Share count to buy. Size so buy_shares × buy_price ≈ trim_shares × trim_price (dollar-neutral).',
      },
      scoreDelta: {
        type: 'number',
        description:
          'candidate_discovery_score − held_position_health. Should be ≥ 0.6 per the rotation threshold; included so the wrapper can audit the model\'s read of the signal.',
      },
      reasoning: {
        type: 'string',
        description:
          'Concrete argument: why TRIM\'s thesis has weakened AND why BUY is positioned better. Tie each side back to its citations.',
        minLength: 1,
      },
      citations: {
        ...citationsSchema,
        description:
          'Evidence for BOTH sides of the rotation. MUST include at least one article backing the trim rationale and at least one backing the buy rationale. The strip-and-confidence pass narrows to resolvable articleIds; if nothing remains the rotation is dropped.',
        minItems: 2,
      },
    },
    required: [
      'trimTicker',
      'trimShares',
      'buyTicker',
      'buyShares',
      'scoreDelta',
      'reasoning',
      'citations',
    ],
    additionalProperties: false,
  },
};

export const EMIT_ALERT_TOOL: Anthropic.Tool = {
  name: 'emit_alert',
  description:
    'Fire an event-driven alert (earnings surprise, 8-K filing, breaking news, ' +
    'large intraday move). Use for time-sensitive updates on held tickers. ALWAYS cite at least one article.',
  input_schema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        description:
          'Short classifier for the alert kind, e.g. "earnings", "filing-8k", "news", "intraday-move".',
      },
      title: {
        type: 'string',
        description: 'Short (≤100 char) headline for the alert notification.',
        minLength: 1,
      },
      body: {
        type: 'string',
        description: 'User-facing detail body. Plain prose, no markdown headers.',
        minLength: 1,
      },
      reasoning: {
        type: 'string',
        description:
          'Internal reasoning for why this event warrants an alert (used for audit log only).',
        minLength: 1,
      },
      citations: citationsSchema,
    },
    required: ['kind', 'title', 'body', 'reasoning', 'citations'],
    additionalProperties: false,
  },
};

/**
 * Initial-thesis synthesis tool — used by the bootstrap job only.
 *
 * NOTE: does NOT require `citations` at the top level. Bootstrap operates over
 * 30 days of news + 2 quarters of filings rendered into the prompt; the goal is
 * to distill a working thesis from that context, not to cite one specific
 * article for each pillar. The regular thesis-evaluation flow supplies the
 * citation discipline once the baseline thesis exists.
 */
export const EMIT_INITIAL_THESIS_TOOL: Anthropic.Tool = {
  name: 'emit_initial_thesis',
  description:
    'Propose an initial thesis based on 30 days of news and 2 quarters of filings. 2-4 pillars, 1-3 risk factors. Pillars must be falsifiable statements.',
  input_schema: {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description:
          'One-paragraph summary of the position thesis distilled from the provided context. Concrete, not marketing copy.',
        minLength: 1,
      },
      pillars: {
        type: 'array',
        description:
          'The load-bearing claims the thesis rests on. 2-4 entries. Each must be a FALSIFIABLE statement — something the next earnings print, filing, or news cycle could disprove.',
        minItems: 2,
        maxItems: 4,
        items: {
          type: 'object',
          properties: {
            statement: {
              type: 'string',
              description:
                'A falsifiable claim. Prefer specific verbs + measurable outcomes ("iPhone unit sales remain flat year-over-year") over vague framing ("strong brand").',
              minLength: 1,
            },
          },
          required: ['statement'],
          additionalProperties: false,
        },
      },
      riskFactors: {
        type: 'array',
        description:
          'The 1-3 biggest ways this thesis could break. Concrete triggering events, not platitudes.',
        minItems: 1,
        maxItems: 3,
        items: {
          type: 'object',
          properties: {
            statement: {
              type: 'string',
              description:
                'A concrete risk — e.g. "DOJ antitrust ruling forces structural changes" rather than "regulation".',
              minLength: 1,
            },
          },
          required: ['statement'],
          additionalProperties: false,
        },
      },
    },
    required: ['summary', 'pillars', 'riskFactors'],
    additionalProperties: false,
  },
};

/**
 * Thesis-evaluation tool — single call produces per-pillar statuses, per-risk
 * triggering updates, and overall rationale. Each pillar carries its own
 * `evidence[]` (citations narrowed to that pillar); `overallCitations[]` is
 * a top-level roll-up for the Insight/Telegram path. Each evidence list may be
 * empty for a given pillar — the engine maps such pillars to Intact (no-change)
 * rather than dropping them, so an unclassifiable pillar doesn't falsely move
 * the thesis.
 */
export const EMIT_THESIS_EVAL_TOOL: Anthropic.Tool = {
  name: 'emit_thesis_eval',
  description:
    'Score every pillar of the current thesis against the provided article window + market events, update any triggered risk factors, and return a single aggregate status for the thesis. Prefer "Intact" when evidence is genuinely mixed or absent — DO NOT invent pressure where none exists.',
  input_schema: {
    type: 'object',
    properties: {
      pillarScores: {
        type: 'array',
        description:
          'Exactly one entry per pillar in the provided thesis, same order. Each pillar gets its own status + evidence list.',
        items: {
          type: 'object',
          properties: {
            pillarIndex: {
              type: 'integer',
              description: 'Zero-based index into the pillars[] array.',
              minimum: 0,
            },
            status: {
              type: 'string',
              enum: ['Intact', 'Strengthening', 'Weakening', 'Broken'],
            },
            evidence: {
              type: 'array',
              description:
                'Articles supporting THIS pillar\'s status. May be empty when no new evidence is available — in that case status MUST be Intact.',
              items: {
                type: 'object',
                properties: {
                  articleId: {
                    type: 'integer',
                    description: 'Article.id from the provided context.',
                  },
                  quote: {
                    type: 'string',
                    description: 'Short verbatim quote from the article.',
                    minLength: 1,
                  },
                },
                required: ['articleId', 'quote'],
                additionalProperties: false,
              },
            },
          },
          required: ['pillarIndex', 'status', 'evidence'],
          additionalProperties: false,
        },
      },
      riskFactorUpdates: {
        type: 'array',
        description:
          'Zero or more risk-factor updates. Omit entries that have no change. `evidence` is required whenever `triggered` is true.',
        items: {
          type: 'object',
          properties: {
            riskIndex: {
              type: 'integer',
              description: 'Zero-based index into the riskFactors[] array.',
              minimum: 0,
            },
            triggered: {
              type: 'boolean',
              description:
                'Whether the risk is now active — e.g. a court ruling, a missed earnings print, a policy change that fires the risk.',
            },
            evidence: {
              type: 'array',
              description: 'Articles supporting the trigger flip.',
              items: {
                type: 'object',
                properties: {
                  articleId: { type: 'integer' },
                  quote: { type: 'string', minLength: 1 },
                },
                required: ['articleId', 'quote'],
                additionalProperties: false,
              },
            },
          },
          required: ['riskIndex', 'triggered', 'evidence'],
          additionalProperties: false,
        },
      },
      overallStatus: {
        type: 'string',
        enum: ['Intact', 'Strengthening', 'Weakening', 'Broken'],
        description:
          'Rolled-up thesis status. The wrapper ALSO computes this from per-pillar statuses; your value is a cross-check.',
      },
      overallRationale: {
        type: 'string',
        description:
          'A short paragraph explaining the aggregate status, tying each material pillar change back to the evidence.',
        minLength: 1,
      },
      overallCitations: {
        type: 'array',
        description:
          'Top-level citation roll-up. Must be non-empty if ANY pillar status is non-Intact or ANY risk is triggered. Each citation must reference an article in the context.',
        items: {
          type: 'object',
          properties: {
            articleId: { type: 'integer' },
            quote: { type: 'string', minLength: 1 },
          },
          required: ['articleId', 'quote'],
          additionalProperties: false,
        },
      },
    },
    required: [
      'pillarScores',
      'riskFactorUpdates',
      'overallStatus',
      'overallRationale',
      'overallCitations',
    ],
    additionalProperties: false,
  },
};

/**
 * Phase 17 — earnings guidance extractor.
 *
 * Fired by pollEarnings whenever an actuals event has surprisePct ≥ 10.
 * Sonnet reads the post-earnings article window (tier-1 + tier-2) and
 * returns its read on guidance direction. The downstream validator drops
 * any call whose `materialQuotes` are not verbatim substrings of a real
 * article body — same anti-hallucination strategy used elsewhere.
 */
export const EXTRACT_EARNINGS_GUIDANCE_TOOL: Anthropic.Tool = {
  name: 'extract_earnings_guidance',
  description:
    "Read the post-earnings article window for one ticker and report the company's forward-guidance direction. Use 'unknown' when the articles do not address guidance or the language is genuinely ambiguous — DO NOT speculate. Every materialQuotes entry must be a VERBATIM short quote from one of the provided articles; the wrapper validates each quote against article bodies and drops the entire call if any quote is fabricated.",
  input_schema: {
    type: 'object',
    properties: {
      direction: {
        type: 'string',
        enum: ['raise', 'hold', 'lower', 'unknown'],
        description:
          "'raise' = guidance lifted, 'hold' = reaffirmed, 'lower' = cut, 'unknown' = articles do not address guidance or it's genuinely ambiguous.",
      },
      confidence: {
        type: 'string',
        enum: ['low', 'medium', 'high'],
        description:
          "Confidence in the direction call. 'high' requires at least one tier-1 quote; 'low' is the default when articles are tier-3-heavy or speculative.",
      },
      materialQuotes: {
        type: 'array',
        description:
          'Verbatim short quotes (≤40 words each) from the article window that justify the direction call. MUST be exact substrings of an article body. The wrapper rejects the call if any quote does not match.',
        minItems: 1,
        items: {
          type: 'string',
          minLength: 1,
        },
      },
    },
    required: ['direction', 'confidence', 'materialQuotes'],
    additionalProperties: false,
  },
};

/**
 * Phase 17 — 8-K classifier.
 *
 * Reads the filing primary text + any tier-1 article in the same 24h
 * window and returns category + materiality + market direction. Materiality
 * ≥ 7 + non-bearish direction = candidate for the catalyst engine. The
 * filing URL must appear in citations; for scores ≥ 7 a tier-1 news
 * citation is also required (validated by the caller, not the tool schema).
 */
export const CLASSIFY_8K_TOOL: Anthropic.Tool = {
  name: 'classify_8k',
  description:
    'Classify a single 8-K filing into a high-level category, score its materiality 1-10, summarize the substance in plain prose, and flag the likely market direction. Categories: contract = material commercial agreements / partnerships / customer wins; mna = mergers / acquisitions / divestitures; fda_regulatory = FDA approvals, court rulings, regulatory wins/losses; officer_change = CEO/CFO/director departures or appointments; reg_fd = pure Reg-FD investor disclosures (analyst day decks etc.); other = catch-all. Materiality 1-3 = boilerplate; 4-6 = informational; 7-8 = market-moving; 9-10 = transformational. Cite the filing URL plus at least one tier-1 news article when materiality ≥ 7.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description:
          '8-K item codes the filing covers, e.g. ["1.01","8.01"]. Use the codes printed in the filing header.',
        items: { type: 'string', minLength: 1 },
        minItems: 1,
      },
      category: {
        type: 'string',
        enum: [
          'contract',
          'mna',
          'fda_regulatory',
          'officer_change',
          'reg_fd',
          'other',
        ],
      },
      materialityScore: {
        type: 'integer',
        description:
          '1 = boilerplate (Reg FD investor deck), 5 = informational change in officer or routine commercial agreement, 8 = material customer / partnership, 10 = company-defining M&A / FDA approval / settlement.',
        minimum: 1,
        maximum: 10,
      },
      summary: {
        type: 'string',
        description:
          'Plain-prose two- or three-sentence summary of the filing substance. No marketing copy; no boilerplate language.',
        minLength: 1,
      },
      marketDirection: {
        type: 'string',
        enum: ['bullish', 'bearish', 'neutral'],
      },
      citations: citationsSchema,
    },
    required: [
      'items',
      'category',
      'materialityScore',
      'summary',
      'marketDirection',
      'citations',
    ],
    additionalProperties: false,
  },
};

export const ALL_TOOLS: readonly Anthropic.Tool[] = [
  EMIT_THESIS_UPDATE_TOOL,
  EMIT_REBALANCE_SUGGESTION_TOOL,
  EMIT_BUY_SUGGESTION_TOOL,
  EMIT_ROTATION_SUGGESTION_TOOL,
  EMIT_ALERT_TOOL,
  EMIT_INITIAL_THESIS_TOOL,
  EMIT_THESIS_EVAL_TOOL,
  EXTRACT_EARNINGS_GUIDANCE_TOOL,
  CLASSIFY_8K_TOOL,
];

export const TOOL_BY_NAME: Record<ToolName, Anthropic.Tool> = {
  emit_thesis_update: EMIT_THESIS_UPDATE_TOOL,
  emit_rebalance_suggestion: EMIT_REBALANCE_SUGGESTION_TOOL,
  emit_buy_suggestion: EMIT_BUY_SUGGESTION_TOOL,
  emit_rotation_suggestion: EMIT_ROTATION_SUGGESTION_TOOL,
  emit_alert: EMIT_ALERT_TOOL,
  emit_initial_thesis: EMIT_INITIAL_THESIS_TOOL,
  emit_thesis_eval: EMIT_THESIS_EVAL_TOOL,
  extract_earnings_guidance: EXTRACT_EARNINGS_GUIDANCE_TOOL,
  classify_8k: CLASSIFY_8K_TOOL,
};

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

/**
 * Runtime guards — keep these aligned with the TypeScript payload types above.
 * These are defensive: the Anthropic tool_use block's `input` is typed as
 * `unknown` at the SDK level, so we validate shape before casting.
 */

function isCitation(x: unknown): x is Citation {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o['articleId'] === 'number' &&
    Number.isInteger(o['articleId']) &&
    typeof o['quote'] === 'string' &&
    (o['quote'] as string).length > 0
  );
}

function isCitationArray(x: unknown): x is Citation[] {
  return Array.isArray(x) && x.every(isCitation);
}

function isConfidence(x: unknown): x is Confidence {
  return x === 'Low' || x === 'Medium' || x === 'High';
}

function isThesisStatus(x: unknown): x is ThesisStatus {
  return (
    x === 'Intact' ||
    x === 'Strengthening' ||
    x === 'Weakening' ||
    x === 'Broken'
  );
}

function isRebalanceAction(x: unknown): x is RebalanceAction {
  return x === 'trim' || x === 'buy' || x === 'rotate' || x === 'exit';
}

export function parseThesisUpdate(input: unknown): ThesisUpdatePayload | null {
  if (typeof input !== 'object' || input === null) return null;
  const o = input as Record<string, unknown>;
  if (
    typeof o['positionId'] !== 'number' ||
    !Number.isInteger(o['positionId']) ||
    !isThesisStatus(o['newStatus']) ||
    typeof o['rationale'] !== 'string' ||
    !isCitationArray(o['citations'])
  ) {
    return null;
  }
  return {
    positionId: o['positionId'] as number,
    newStatus: o['newStatus'],
    rationale: o['rationale'] as string,
    citations: o['citations'],
  };
}

export function parseRebalanceSuggestion(
  input: unknown,
): RebalanceSuggestionPayload | null {
  if (typeof input !== 'object' || input === null) return null;
  const o = input as Record<string, unknown>;
  if (
    !isRebalanceAction(o['action']) ||
    typeof o['ticker'] !== 'string' ||
    typeof o['shares'] !== 'number' ||
    typeof o['reasoning'] !== 'string' ||
    !isCitationArray(o['citations']) ||
    !isConfidence(o['confidence'])
  ) {
    return null;
  }
  const parsed: RebalanceSuggestionPayload = {
    action: o['action'],
    ticker: o['ticker'] as string,
    shares: o['shares'] as number,
    reasoning: o['reasoning'] as string,
    citations: o['citations'],
    confidence: o['confidence'],
  };
  if (typeof o['targetTicker'] === 'string' && (o['targetTicker'] as string).length > 0) {
    parsed.targetTicker = o['targetTicker'] as string;
  }
  return parsed;
}

export function parseRotationSuggestion(
  input: unknown,
): RotationSuggestionPayload | null {
  if (typeof input !== 'object' || input === null) return null;
  const o = input as Record<string, unknown>;
  if (
    typeof o['trimTicker'] !== 'string' ||
    (o['trimTicker'] as string).length === 0 ||
    typeof o['trimShares'] !== 'number' ||
    !Number.isFinite(o['trimShares'] as number) ||
    (o['trimShares'] as number) <= 0 ||
    typeof o['buyTicker'] !== 'string' ||
    (o['buyTicker'] as string).length === 0 ||
    typeof o['buyShares'] !== 'number' ||
    !Number.isFinite(o['buyShares'] as number) ||
    (o['buyShares'] as number) <= 0 ||
    typeof o['scoreDelta'] !== 'number' ||
    !Number.isFinite(o['scoreDelta'] as number) ||
    typeof o['reasoning'] !== 'string' ||
    (o['reasoning'] as string).length === 0 ||
    !isCitationArray(o['citations'])
  ) {
    return null;
  }
  return {
    trimTicker: (o['trimTicker'] as string).toUpperCase(),
    trimShares: o['trimShares'] as number,
    buyTicker: (o['buyTicker'] as string).toUpperCase(),
    buyShares: o['buyShares'] as number,
    scoreDelta: o['scoreDelta'] as number,
    reasoning: o['reasoning'] as string,
    citations: o['citations'],
  };
}

function isCatalystKind(x: unknown): x is CatalystKind {
  return (
    x === 'InsiderCluster' ||
    x === 'EarningsBeat' ||
    x === 'Material8K' ||
    x === 'AnalystUpgrade' ||
    x === 'mixed'
  );
}

function isConjunctionLevel(x: unknown): x is ConjunctionLevel {
  return x === 1 || x === 2 || x === 3;
}

export function parseBuySuggestion(
  input: unknown,
): BuySuggestionPayload | null {
  if (typeof input !== 'object' || input === null) return null;
  const o = input as Record<string, unknown>;
  if (
    typeof o['ticker'] !== 'string' ||
    typeof o['shares'] !== 'number' ||
    typeof o['reasoning'] !== 'string' ||
    !isCitationArray(o['citations']) ||
    !isConfidence(o['confidence'])
  ) {
    return null;
  }
  const out: BuySuggestionPayload = {
    ticker: o['ticker'] as string,
    shares: o['shares'] as number,
    reasoning: o['reasoning'] as string,
    citations: o['citations'],
    confidence: o['confidence'],
  };
  if (isCatalystKind(o['catalystKind'])) {
    out.catalystKind = o['catalystKind'];
  }
  if (isConjunctionLevel(o['conjunctionLevel'])) {
    out.conjunctionLevel = o['conjunctionLevel'];
  }
  return out;
}

export function parseInitialThesis(
  input: unknown,
): InitialThesisPayload | null {
  if (typeof input !== 'object' || input === null) return null;
  const o = input as Record<string, unknown>;
  if (typeof o['summary'] !== 'string' || (o['summary'] as string).length === 0)
    return null;
  if (!Array.isArray(o['pillars']) || !Array.isArray(o['riskFactors']))
    return null;

  const pillars: InitialThesisPillar[] = [];
  for (const p of o['pillars']) {
    if (typeof p !== 'object' || p === null) return null;
    const pr = p as Record<string, unknown>;
    if (typeof pr['statement'] !== 'string' || (pr['statement'] as string).length === 0)
      return null;
    pillars.push({ statement: pr['statement'] as string });
  }
  if (pillars.length < 2 || pillars.length > 4) return null;

  const riskFactors: InitialThesisRiskFactor[] = [];
  for (const r of o['riskFactors']) {
    if (typeof r !== 'object' || r === null) return null;
    const rr = r as Record<string, unknown>;
    if (typeof rr['statement'] !== 'string' || (rr['statement'] as string).length === 0)
      return null;
    riskFactors.push({ statement: rr['statement'] as string });
  }
  if (riskFactors.length < 1 || riskFactors.length > 3) return null;

  return {
    summary: o['summary'] as string,
    pillars,
    riskFactors,
  };
}

function isPillarStatus(x: unknown): x is PillarEvaluationStatus {
  return (
    x === 'Intact' ||
    x === 'Strengthening' ||
    x === 'Weakening' ||
    x === 'Broken'
  );
}

function parsePillarEvidence(x: unknown): PillarEvaluationEvidence[] | null {
  if (!Array.isArray(x)) return null;
  const out: PillarEvaluationEvidence[] = [];
  for (const entry of x) {
    if (typeof entry !== 'object' || entry === null) return null;
    const o = entry as Record<string, unknown>;
    if (
      typeof o['articleId'] !== 'number' ||
      !Number.isInteger(o['articleId']) ||
      typeof o['quote'] !== 'string' ||
      (o['quote'] as string).length === 0
    ) {
      return null;
    }
    out.push({
      articleId: o['articleId'] as number,
      quote: o['quote'] as string,
    });
  }
  return out;
}

export function parseThesisEval(input: unknown): ThesisEvalPayload | null {
  if (typeof input !== 'object' || input === null) return null;
  const o = input as Record<string, unknown>;

  if (!Array.isArray(o['pillarScores'])) return null;
  const pillarScores: PillarEvaluation[] = [];
  for (const p of o['pillarScores']) {
    if (typeof p !== 'object' || p === null) return null;
    const pr = p as Record<string, unknown>;
    if (
      typeof pr['pillarIndex'] !== 'number' ||
      !Number.isInteger(pr['pillarIndex']) ||
      (pr['pillarIndex'] as number) < 0 ||
      !isPillarStatus(pr['status'])
    ) {
      return null;
    }
    const evidence = parsePillarEvidence(pr['evidence']);
    if (evidence === null) return null;
    pillarScores.push({
      pillarIndex: pr['pillarIndex'] as number,
      status: pr['status'],
      evidence,
    });
  }

  if (!Array.isArray(o['riskFactorUpdates'])) return null;
  const riskFactorUpdates: RiskFactorUpdate[] = [];
  for (const r of o['riskFactorUpdates']) {
    if (typeof r !== 'object' || r === null) return null;
    const rr = r as Record<string, unknown>;
    if (
      typeof rr['riskIndex'] !== 'number' ||
      !Number.isInteger(rr['riskIndex']) ||
      (rr['riskIndex'] as number) < 0 ||
      typeof rr['triggered'] !== 'boolean'
    ) {
      return null;
    }
    const evidence = parsePillarEvidence(rr['evidence']);
    if (evidence === null) return null;
    riskFactorUpdates.push({
      riskIndex: rr['riskIndex'] as number,
      triggered: rr['triggered'] as boolean,
      evidence,
    });
  }

  if (
    !isPillarStatus(o['overallStatus']) ||
    typeof o['overallRationale'] !== 'string' ||
    (o['overallRationale'] as string).length === 0
  ) {
    return null;
  }

  const overallEvidence = parsePillarEvidence(o['overallCitations']);
  if (overallEvidence === null) return null;

  return {
    pillarScores,
    riskFactorUpdates,
    overallStatus: o['overallStatus'],
    overallRationale: o['overallRationale'] as string,
    overallCitations: overallEvidence,
  };
}

export function parseEarningsGuidance(
  input: unknown,
): EarningsGuidancePayload | null {
  if (typeof input !== 'object' || input === null) return null;
  const o = input as Record<string, unknown>;
  const direction = o['direction'];
  if (
    direction !== 'raise' &&
    direction !== 'hold' &&
    direction !== 'lower' &&
    direction !== 'unknown'
  ) {
    return null;
  }
  const confidence = o['confidence'];
  if (
    confidence !== 'low' &&
    confidence !== 'medium' &&
    confidence !== 'high'
  ) {
    return null;
  }
  if (!Array.isArray(o['materialQuotes'])) return null;
  const quotes: string[] = [];
  for (const q of o['materialQuotes']) {
    if (typeof q !== 'string' || q.length === 0) return null;
    quotes.push(q);
  }
  if (quotes.length === 0) return null;
  return { direction, confidence, materialQuotes: quotes };
}

export function parseEightKClassification(
  input: unknown,
): EightKClassificationPayload | null {
  if (typeof input !== 'object' || input === null) return null;
  const o = input as Record<string, unknown>;
  if (!Array.isArray(o['items'])) return null;
  const items: string[] = [];
  for (const it of o['items']) {
    if (typeof it !== 'string' || it.length === 0) return null;
    items.push(it);
  }
  if (items.length === 0) return null;
  const category = o['category'];
  if (
    category !== 'contract' &&
    category !== 'mna' &&
    category !== 'fda_regulatory' &&
    category !== 'officer_change' &&
    category !== 'reg_fd' &&
    category !== 'other'
  ) {
    return null;
  }
  const score = o['materialityScore'];
  if (
    typeof score !== 'number' ||
    !Number.isInteger(score) ||
    score < 1 ||
    score > 10
  ) {
    return null;
  }
  if (typeof o['summary'] !== 'string' || (o['summary'] as string).length === 0)
    return null;
  const direction = o['marketDirection'];
  if (
    direction !== 'bullish' &&
    direction !== 'bearish' &&
    direction !== 'neutral'
  ) {
    return null;
  }
  if (!isCitationArray(o['citations'])) return null;
  return {
    items,
    category,
    materialityScore: score,
    summary: o['summary'] as string,
    marketDirection: direction,
    citations: o['citations'],
  };
}

export function parseAlert(input: unknown): AlertPayload | null {
  if (typeof input !== 'object' || input === null) return null;
  const o = input as Record<string, unknown>;
  if (
    typeof o['kind'] !== 'string' ||
    typeof o['title'] !== 'string' ||
    typeof o['body'] !== 'string' ||
    typeof o['reasoning'] !== 'string' ||
    !isCitationArray(o['citations'])
  ) {
    return null;
  }
  return {
    kind: o['kind'] as string,
    title: o['title'] as string,
    body: o['body'] as string,
    reasoning: o['reasoning'] as string,
    citations: o['citations'],
  };
}

/**
 * Extract all tool_use blocks from an Anthropic response, parse each into a
 * typed payload, and return them in order. Unknown tool names are dropped with
 * a console warn (should never happen — the model can only call tools we define).
 * Validation-failed blocks are dropped silently (upstream can compare count).
 */
export function parseToolCalls(
  response: Anthropic.Message,
): ParsedToolCall[] {
  const out: ParsedToolCall[] = [];
  for (const block of response.content) {
    if (block.type !== 'tool_use') continue;
    const { name, id, input } = block;
    switch (name) {
      case 'emit_thesis_update': {
        const payload = parseThesisUpdate(input);
        if (payload) out.push({ kind: 'emit_thesis_update', id, payload });
        break;
      }
      case 'emit_rebalance_suggestion': {
        const payload = parseRebalanceSuggestion(input);
        if (payload)
          out.push({ kind: 'emit_rebalance_suggestion', id, payload });
        break;
      }
      case 'emit_buy_suggestion': {
        const payload = parseBuySuggestion(input);
        if (payload) out.push({ kind: 'emit_buy_suggestion', id, payload });
        break;
      }
      case 'emit_rotation_suggestion': {
        const payload = parseRotationSuggestion(input);
        if (payload)
          out.push({ kind: 'emit_rotation_suggestion', id, payload });
        break;
      }
      case 'emit_alert': {
        const payload = parseAlert(input);
        if (payload) out.push({ kind: 'emit_alert', id, payload });
        break;
      }
      case 'emit_initial_thesis': {
        const payload = parseInitialThesis(input);
        if (payload) out.push({ kind: 'emit_initial_thesis', id, payload });
        break;
      }
      case 'emit_thesis_eval': {
        const payload = parseThesisEval(input);
        if (payload) out.push({ kind: 'emit_thesis_eval', id, payload });
        break;
      }
      case 'extract_earnings_guidance': {
        const payload = parseEarningsGuidance(input);
        if (payload)
          out.push({ kind: 'extract_earnings_guidance', id, payload });
        break;
      }
      case 'classify_8k': {
        const payload = parseEightKClassification(input);
        if (payload) out.push({ kind: 'classify_8k', id, payload });
        break;
      }
      default: {
        console.warn(`[llm/tools] ignoring unknown tool_use name: ${name}`);
      }
    }
  }
  return out;
}
