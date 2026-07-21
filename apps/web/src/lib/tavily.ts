// Tavily search wrapper. Tavily is a search engine purpose-built for LLM
// agents — its own crawler indexes Reuters, WSJ, FT, etc. that block
// Anthropic's ClaudeBot directly. Free tier: 1000 searches/month.
//
// API docs: https://docs.tavily.com/docs/rest-api/api-reference

import { componentLogger } from '@vantage/notify';

const log = componentLogger('web/lib/tavily');

export interface TavilySearchInput {
  query: string;
  maxResults?: number;
  days?: number;
}

export interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
  published_date?: string;
}

export interface TavilyResponse {
  answer: string | null;
  results: TavilyResult[];
  query: string;
}

export async function tavilySearch(
  input: TavilySearchInput,
): Promise<TavilyResponse | { error: string }> {
  const key = process.env['TAVILY_API_KEY'];
  if (!key) return { error: 'TAVILY_API_KEY not configured' };
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: key,
        query: input.query,
        search_depth: 'advanced',
        max_results: input.maxResults ?? 5,
        days: input.days ?? 14,
        include_raw_content: false,
        include_answer: true,
        topic: 'news',
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const responseBody = await res.text().catch(() => '');
      log.warn(
        { status: res.status, responseBody: responseBody.slice(0, 500) },
        'tavily search rejected',
      );
      return { error: 'news search unavailable' };
    }
    return (await res.json()) as TavilyResponse;
  } catch (e) {
    log.error({ err: e }, 'tavily search failed');
    return { error: 'news search unavailable' };
  }
}
