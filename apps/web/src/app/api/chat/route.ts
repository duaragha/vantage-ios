/**
 * POST /api/chat — single-turn Claude chat with pgvector-backed retrieval.
 *
 * Flow:
 *   1. Embed user message.
 *   2. Pull a structured context bundle (articles, theses, discovery scores,
 *      ticker metrics, last-4-quarter fundamentals, recent market events, and
 *      multi-window price summaries) via apps/web/src/lib/chatRetrieval.ts.
 *   3. Build portfolio snapshot + format the retrieved bundle.
 *   4. Call Sonnet (non-streaming for v1; streaming is a future enhancement).
 *   5. Persist user + assistant turns to ChatMessage.
 *
 * GET returns the active thread and its last 100 messages so the UI can render
 * that conversation without mixing context across sessions.
 *
 * Cache contract: `buildSystemPrompt() + buildPortfolioContext()` is the
 * cache-stable prefix. The retrieved bundle is concatenated AFTER that block,
 * so per-message volatility doesn't pollute the cache.
 */

import { NextResponse } from 'next/server';
import {
  listOpenPositions,
  prisma,
  searchArticlesByEmbedding,
  searchThesisEvaluationsByEmbedding,
} from '@vantage/db';
import type { Prisma } from '@vantage/db';
import { buildPortfolioContext, buildSystemPrompt, callClaude, SONNET_MODEL } from '@vantage/llm';
import { componentLogger } from '@vantage/notify';
import {
  collectAnthropicWebCitations,
  collectTavilyCitationCandidates,
  selectUsedChatCitations,
  type ChatCitation,
} from '@/lib/chatCitations';
import { formatRetrievedBlock, retrieveChatContext, type EmbedModule } from '@/lib/chatRetrieval';
import { tavilySearch } from '@/lib/tavily';
import { embedderConfigured, embedText } from '@/lib/embedderClient';
import { isAuthed } from '@/lib/auth';
import { normalizeChatMessage } from '@/lib/chatInput';
import { handleMutationTool, MUTATION_TOOLS, MUTATION_TOOL_NAMES } from './mutationTools';

const log = componentLogger('web/api/chat');
const MAX_TICKER_CANDIDATES = 32;

async function loadEmbed(): Promise<EmbedModule | null> {
  if (!embedderConfigured()) return null;
  return {
    embed: embedText,
    searchArticles: searchArticlesByEmbedding,
    searchThesisEvaluations: searchThesisEvaluationsByEmbedding,
  };
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Case-insensitive so lowercase-typed tickers ("acel", "rklb") also get
// extracted. The retrieval layer treats unknown tickers as empty results,
// so picking up common English words as false-positive candidates is cheap.
const TICKER_RE = /\b([A-Za-z]{1,6})\b/g;

/**
 * Sentence appended to the cached system prompt so the model knows what
 * structured context lives in the retrieved block. The text itself is static —
 * still safe to append to the cached prefix (it's the same string every call),
 * but to stay defensive we place it BEFORE the dynamic retrieved block.
 */
const CONTEXT_AWARENESS_SUFFIX = `You have access to the user's discovery score table, ticker metrics, fundamentals snapshots (last 4 quarters), recent market events (60d), and 30-day / 6-month / 1-year price summaries for any ticker. When the user asks about a score, cite the breakdown components. When they ask about growth or valuation, cite the metrics + fundamentals deltas.

When asked about a discovery score, enumerate EVERY component of the breakdown — including ones that are zero, negative, or weak — and explain what each measures and why this ticker scored where it did. Do not skip components even if they are not flattering.

When insider transactions or material filings appear in the events section, name the insider (full name), dollar amount, date, and direction (buy vs sell). Do not summarize away these concrete signals — list them individually.

When the user quotes a price-change percentage that disagrees with the 30-day price action data shown, use the data value and explicitly note the discrepancy.

You have FULL READ access to:
- The user's portfolio (positions, accounts, contribution rooms)
- Their goals (with progress, linked positions, and recommended account + top securities)
- Their watchlist
- Recent insights / alerts the engine has emitted (last 20)
- System health: when each cron last ran, today's LLM spend vs cap, kill-switch state
- User settings: position cap, sector cap, intraday move threshold, discovery weights, timezone
- Last 5 turns of THIS conversation (for follow-up questions)

When the user asks ANYTHING about their own data — goals, watchlist, spend, last job run, settings, prior conversation — answer from this context. Never say "I don't have access to that." If a section is explicitly marked unavailable, say it is temporarily unavailable and do not substitute zero, off, or an empty list. Only say "You don't have any X yet" when the context confirms the section loaded successfully and is empty.

Goals also have an optional \`strategy\` field (Income / Growth / Balanced / Preservation) shown on each goal's headline when set. When set, it overrides the type-based default for security selection — Income biases toward dividend/REIT picks, Growth toward broad-market and growth ETFs, Balanced spreads across all three sleeves, Preservation forces cash/short-bond. When the user asks about a goal, mention the strategy if it's set and what it implies for the picks (e.g. "this is a Growth-focused Retirement goal so top picks are growth ETFs + discovery picks, not dividend stocks"). Tax considerations remain automatic — never lecture the user about tax wrappers in the context of strategy.

You also have access to a web_search tool. If the user asks a factual question that the in-DB context does NOT cover (e.g., "what does company X do?", "what's the latest news on Y?", "what's a typical P/E for this sector?"), invoke web_search to look it up. Cite the source URL. Limit to 3 searches per response.

You ALSO have a \`news_search\` tool that uses Tavily — a search engine with broader coverage than the built-in web_search. Tavily can reach paywalled financial publications (Reuters, WSJ, FT, Bloomberg, MarketWatch, Barrons) that the built-in web_search is blocked from. Use news_search SPECIFICALLY when:
- The user asks for "the latest news" on a ticker or topic
- The user wants analyst coverage or quotes from named publications
- The built-in web_search returns no useful results

Cite the URL of any source you quote. Limit news_search to 3 calls per response.

Prefer in-DB context when it has the answer (discovery scores, ticker metrics, fundamentals, recent events, prior conversation). Only fall back to web_search when the DB context is genuinely empty for the topic.

ALSO note: the user's price-action data now shows 30-day, 6-month, and 1-year returns. Use the right window for the user's question (e.g., "how's it done this year?" → 1y; "recent move?" → 30d).

ACTIONS — you can now edit the user's data via tools, not just answer:
- create_goal, update_goal, archive_goal (soft, recoverable), link_position_to_goal, unlink_position_from_goal, set_goal_contribution (DCA schedule), add_watchlist, remove_watchlist.
- Resolve goals/positions by the goalId/positionId shown in "Your goals" / "Your accounts"; resolve tickers by symbol. Never guess an ID — if it's not in context, ask.
- create_goal, add_watchlist, remove_watchlist execute immediately.
- update_goal, archive_goal, link/unlink_position, set_goal_contribution are CONFIRM-BEFORE-WRITE: FIRST call the tool WITHOUT confirm (or confirm:false). It returns a preview (status:"preview") with the exact before→after diff and writes nothing. Show the user that change in plain language and ask them to confirm. ONLY after they explicitly agree ("yes", "do it", "go ahead") call the SAME tool again with identical args plus confirm:true. Never set confirm:true on the first call.
- Holdings (position shares/avg cost) are READ-ONLY brokerage truth — there is no tool to edit them; never claim you changed a holding.
- Keep confirmations and post-action summaries to one or two short sentences.`;

// Anthropic's server-side web_search tool. The domain whitelist keeps the
// model anchored on finance + reputable general-research sources; max_uses
// caps cost at ~$0.03/turn (3 × $0.01) plus the per-token cost of the
// retrieved page content (already captured in usage.input_tokens).
const WEB_SEARCH_TOOL = {
  type: 'web_search_20250305' as const,
  name: 'web_search' as const,
  max_uses: 3,
  // Anthropic's web crawler is blocked by Reuters/WSJ/FT/Bloomberg/MarketWatch/
  // Barrons/Forbes via robots.txt (and the API rejects the entire request when
  // ANY domain in the list is blocked). Restricting to crawler-friendly
  // finance + reference sources.
  allowed_domains: [
    'sec.gov',
    'finance.yahoo.com',
    'cnbc.com',
    'morningstar.com',
    'seekingalpha.com',
    'finnhub.io',
    'wikipedia.org',
    'investor.gov',
    'fool.com',
    'simplywall.st',
    'stockanalysis.com',
    'macrotrends.net',
    'finviz.com',
    'businesswire.com',
    'globenewswire.com',
    'prnewswire.com',
  ],
};

// Client-side tool: model returns a tool_use block, we fetch Tavily, send back
// a tool_result. Unlike the server-side web_search_20250305, this requires a
// multi-turn loop in the route handler below.
const TAVILY_NEWS_TOOL = {
  name: 'news_search',
  description:
    'Search Tavily for current financial news + analyst coverage. Tavily indexes paywalled sources (Reuters, WSJ, FT, Bloomberg, MarketWatch) that the built-in web_search cannot reach. Use this for "what is the latest news on X" or "what are analysts saying about Y" when the in-DB articles and built-in web_search lack coverage.',
  input_schema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'Focused search query, e.g. "ACGL earnings Q1 2026"',
      },
      max_results: {
        type: 'number',
        description: 'Max results, default 5',
      },
      days: {
        type: 'number',
        description: 'Time window in days, default 14',
      },
    },
    required: ['query'],
  },
};

function titleFromMessage(message: string): string {
  const oneLine = message.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= 56) return oneLine;
  return `${oneLine.slice(0, 53).trimEnd()}...`;
}

export async function GET(req: Request): Promise<Response> {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const rawThreadId = new URL(req.url).searchParams.get('threadId');
    const parsedThreadId = rawThreadId === null ? null : Number(rawThreadId);
    if (parsedThreadId !== null && (!Number.isSafeInteger(parsedThreadId) || parsedThreadId <= 0)) {
      return NextResponse.json({ error: 'valid threadId required' }, { status: 400 });
    }

    const thread = await prisma.chatThread.findFirst({
      where:
        parsedThreadId === null ? { archivedAt: null } : { id: parsedThreadId, archivedAt: null },
      orderBy: parsedThreadId === null ? { updatedAt: 'desc' } : undefined,
      select: { id: true, title: true, createdAt: true, updatedAt: true },
    });
    if (!thread) return NextResponse.json({ thread: null, messages: [] });

    const rows = await prisma.chatMessage.findMany({
      where: { threadId: thread.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return NextResponse.json({ thread, messages: rows.reverse() });
  } catch (err) {
    log.error({ err }, 'chat GET failed loading history');
    return NextResponse.json({ error: 'chat history unavailable', messages: [] }, { status: 500 });
  }
}

export async function POST(req: Request): Promise<Response> {
  // Defense-in-depth: middleware already gates /api/chat on the iron-session
  // cookie, but the chat loop can now MUTATE financial data, so re-check the
  // session here rather than trusting the edge layer alone.
  if (!(await isAuthed())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let payload: { message?: string; threadId?: number };
  try {
    payload = (await req.json()) as { message?: string; threadId?: number };
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const normalizedMessage = normalizeChatMessage(payload.message);
  if (!normalizedMessage.ok) {
    return NextResponse.json(
      { error: normalizedMessage.error },
      { status: normalizedMessage.status },
    );
  }
  const message = normalizedMessage.message;

  if (
    payload.threadId !== undefined &&
    (!Number.isSafeInteger(payload.threadId) || payload.threadId <= 0)
  ) {
    return NextResponse.json({ error: 'valid threadId required' }, { status: 400 });
  }

  try {
    let thread = payload.threadId
      ? await prisma.chatThread.findFirst({
          where: { id: payload.threadId, archivedAt: null },
          select: { id: true, title: true, createdAt: true, updatedAt: true },
        })
      : null;
    if (payload.threadId && !thread) {
      return NextResponse.json({ error: 'chat thread not found' }, { status: 404 });
    }

    if (!thread) {
      thread = await prisma.chatThread.create({
        data: { title: titleFromMessage(message) },
        select: { id: true, title: true, createdAt: true, updatedAt: true },
      });
    } else if (thread.title === 'New chat') {
      const priorUserTurns = await prisma.chatMessage.count({
        where: { threadId: thread.id, role: 'user' },
      });
      if (priorUserTurns === 0) {
        thread = await prisma.chatThread.update({
          where: { id: thread.id },
          data: { title: titleFromMessage(message) },
          select: { id: true, title: true, createdAt: true, updatedAt: true },
        });
      }
    }

    // Persist the user turn before we do anything else — we want history even
    // if Claude fails.
    const userRow = await prisma.chatMessage.create({
      data: { threadId: thread.id, role: 'user', content: message },
    });

    let assistantText = '';
    let citations: ChatCitation[] = [];
    try {
      const mentioned = extractTickers(message);
      const held = (await listOpenPositions()).map((p) => p.ticker);

      const embedMod = await loadEmbed();
      let queryEmbedding: number[] | null = null;
      if (embedMod) {
        try {
          queryEmbedding = await embedMod.embed(message);
        } catch {
          queryEmbedding = null;
        }
      }

      const bundle = await retrieveChatContext({
        message,
        threadId: thread.id,
        mentionedTickers: mentioned,
        heldTickers: held,
        embedMod,
        queryEmbedding,
        // Exclude the just-persisted user turn so it doesn't show up in its own
        // recent-conversation block.
        excludeMessagesAfter: userRow.createdAt,
      });

      const portfolioCtx = await buildPortfolioContext();
      const systemPrompt = buildSystemPrompt();

      const retrievedBlock = formatRetrievedBlock(bundle, { userMessage: message });

      // Cache-stable prefix (system + portfolio + static awareness suffix) is
      // concatenated FIRST. The dynamic retrieved block lands after so the
      // cached prefix bytes stay identical across messages.
      const combinedSystem = `${systemPrompt}\n\n${CONTEXT_AWARENESS_SUFFIX}\n\n${portfolioCtx}\n\n${retrievedBlock}`;

      try {
        // Multi-turn loop: the built-in web_search_20250305 is server-side and
        // resolves inside Anthropic's API in one round-trip, BUT the
        // client-side news_search (Tavily) requires us to satisfy each tool_use
        // by appending a tool_result and re-calling. We cap at 5 turns + 3
        // Tavily calls so a runaway model can't spin or blow the budget.
        type ChatMessages = Parameters<typeof callClaude>[0]['messages'];
        const messages: ChatMessages = [{ role: 'user', content: message }];
        let tavilyCalls = 0;
        const explicitWebCitations: ChatCitation[] = [];
        const tavilyCitationCandidates: ChatCitation[] = [];
        const MAX_TAVILY_CALLS = 3;
        const MAX_TURNS = 5;

        for (let turn = 0; turn < MAX_TURNS; turn++) {
          const result = await callClaude({
            model: SONNET_MODEL,
            system: combinedSystem,
            messages,
            purpose: 'chat',
            cacheSystem: true,
            tools: [WEB_SEARCH_TOOL, TAVILY_NEWS_TOOL, ...MUTATION_TOOLS],
          });

          // Accumulate text blocks from this turn into the user-visible reply.
          for (const block of result.response.content) {
            if (block.type === 'text') assistantText += block.text;
          }
          explicitWebCitations.push(
            ...collectAnthropicWebCitations(result.response.content as unknown),
          );

          // Filter to client-side tool_use blocks we must satisfy: the Tavily
          // news_search plus the goal/watchlist mutation tools. Server-side tools
          // (web_search_20250305) are resolved by Anthropic and skipped here.
          const toolUses = result.response.content.filter(
            (b): b is Extract<typeof b, { type: 'tool_use' }> =>
              b.type === 'tool_use' &&
              (b.name === 'news_search' || MUTATION_TOOL_NAMES.has(b.name)),
          );

          if (toolUses.length === 0 || result.response.stop_reason !== 'tool_use') {
            break;
          }

          // Echo the assistant's full turn back, then deliver tool_results in
          // a single user message — required shape per Anthropic docs.
          messages.push({ role: 'assistant', content: result.response.content });

          type ToolResultBlock = {
            type: 'tool_result';
            tool_use_id: string;
            content: string;
            is_error?: boolean;
          };
          const toolResults: ToolResultBlock[] = [];

          for (const tu of toolUses) {
            // --- Goal / watchlist mutation tools -----------------------------
            if (MUTATION_TOOL_NAMES.has(tu.name)) {
              const out = await handleMutationTool(tu.name, tu.input);
              toolResults.push({
                type: 'tool_result',
                tool_use_id: tu.id,
                content: JSON.stringify(out.json),
                ...(out.isError ? { is_error: true } : {}),
              });
              continue;
            }

            // --- Tavily news_search ------------------------------------------
            if (tavilyCalls >= MAX_TAVILY_CALLS) {
              toolResults.push({
                type: 'tool_result',
                tool_use_id: tu.id,
                content: JSON.stringify({ error: 'tavily call cap reached' }),
                is_error: true,
              });
              continue;
            }
            tavilyCalls++;
            const input = tu.input as {
              query: string;
              max_results?: number;
              days?: number;
            };
            log.info(
              {
                event: 'tavily-call',
                query: input.query,
                maxResults: input.max_results,
                days: input.days,
                callIndex: tavilyCalls,
              },
              'tavily news_search invoked',
            );
            const data = await tavilySearch({
              query: input.query,
              maxResults: input.max_results,
              days: input.days,
            });
            const isError = 'error' in data;
            if (isError) {
              log.warn(
                { event: 'tavily-error', error: data.error, query: input.query },
                'tavily news_search returned error',
              );
            } else {
              tavilyCitationCandidates.push(...collectTavilyCitationCandidates(data));
              log.info(
                {
                  event: 'tavily-result',
                  resultCount: data.results.length,
                  query: input.query,
                },
                'tavily news_search returned results',
              );
            }
            toolResults.push({
              type: 'tool_result',
              tool_use_id: tu.id,
              content: JSON.stringify(data),
              ...(isError ? { is_error: true } : {}),
            });
          }

          messages.push({
            role: 'user',
            content: toolResults as unknown as Parameters<
              typeof callClaude
            >[0]['messages'][number]['content'],
          });
        }

        citations = selectUsedChatCitations({
          assistantText,
          explicitWeb: explicitWebCitations,
          tavilyCandidates: tavilyCitationCandidates,
          articleCandidates: bundle.articleHits,
        });
      } catch (err) {
        log.error({ err }, 'chat Claude call failed');
        assistantText = 'Chat is temporarily unavailable. Please try again.';
      }
    } catch (err) {
      log.error({ err }, 'chat context preparation failed');
      assistantText = 'Chat is temporarily unavailable. Please try again.';
      citations = [];
    }

    if (!assistantText.trim()) {
      log.warn({ threadId: thread.id }, 'chat completed without assistant text');
      assistantText = 'Chat could not produce a response. Please try again.';
      citations = [];
    }

    const assistantRow = await prisma.chatMessage.create({
      data: {
        threadId: thread.id,
        role: 'assistant',
        content: assistantText,
        citations: citations as unknown as Prisma.InputJsonValue,
      },
    });
    thread = await prisma.chatThread.update({
      where: { id: thread.id },
      data: { updatedAt: new Date() },
      select: { id: true, title: true, createdAt: true, updatedAt: true },
    });

    return NextResponse.json({
      thread,
      user: userRow,
      assistant: assistantRow,
      citations,
    });
  } catch (err) {
    log.error({ err }, 'chat POST failed');
    return NextResponse.json({ error: 'chat unavailable' }, { status: 500 });
  }
}

// Common English words that aren't tickers, to keep the candidate set sane.
// Real tickers that collide with these (HE — Hawaiian Electric, OR — Oregon
// nothing-listed) can be re-added by the user explicitly typing uppercase.
const TICKER_STOPWORDS = new Set([
  'A',
  'I',
  'AN',
  'AS',
  'AT',
  'BE',
  'BY',
  'DO',
  'GO',
  'HE',
  'IF',
  'IN',
  'IS',
  'IT',
  'MY',
  'NO',
  'OF',
  'ON',
  'OR',
  'SO',
  'TO',
  'UP',
  'US',
  'WE',
  'THE',
  'AND',
  'ARE',
  'BUT',
  'CAN',
  'FOR',
  'GET',
  'GOT',
  'HAS',
  'HAD',
  'HOW',
  'ITS',
  'LET',
  'MAY',
  'NOT',
  'NOW',
  'OUR',
  'OUT',
  'PUT',
  'SAY',
  'SEE',
  'SHE',
  'TOO',
  'WAS',
  'WAY',
  'WHO',
  'WHY',
  'YOU',
  'THAT',
  'THIS',
  'WITH',
  'WHAT',
  'FROM',
  'THEY',
  'WERE',
  'WHEN',
  'HERE',
  'BEEN',
  'SAID',
  'HAVE',
  'WOULD',
  'COULD',
  'SHOULD',
  'GOING',
  'WHICH',
  'BEING',
  'ABOUT',
  'SCORE',
  'STOCK',
  'GOOD',
  'BAD',
  'HIGH',
  'LOW',
  'LIKE',
  'DOWN',
  'LAST',
  'DAY',
  'DAYS',
  'WEEK',
  'YEAR',
  'MONTH',
  'LOOK',
  'THINK',
]);

function extractTickers(text: string): string[] {
  const matches = text.match(TICKER_RE) ?? [];
  const out = new Set<string>();
  for (const m of matches) {
    if (m.length < 2 || m.length > 5) continue;
    const upper = m.toUpperCase();
    if (TICKER_STOPWORDS.has(upper)) continue;
    out.add(upper);
    if (out.size >= MAX_TICKER_CANDIDATES) break;
  }
  return [...out];
}
