export type ChatCitationSource = 'article' | 'web_search' | 'news_search';

export interface ChatCitation {
  articleId: number | null;
  quote: string;
  title?: string;
  url?: string;
  source?: ChatCitationSource;
}

interface ArticleCitationCandidate {
  id: number;
  headline: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function cleanText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.trim();
  return cleaned || undefined;
}

function cleanUrl(value: unknown): string | undefined {
  const raw = cleanText(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function canonicalUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return value.replace(/\/$/, '');
  }
}

function dedupeCitations(citations: ChatCitation[]): ChatCitation[] {
  const seen = new Set<string>();
  return citations.filter((citation) => {
    const key = citation.url
      ? `url:${canonicalUrl(citation.url)}`
      : `article:${citation.articleId ?? 'unknown'}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function normalizeStoredChatCitations(value: unknown): ChatCitation[] {
  if (!Array.isArray(value)) return [];

  const normalized: ChatCitation[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const articleId = typeof item['articleId'] === 'number' ? item['articleId'] : null;
    const url = cleanUrl(item['url']);
    const quote = cleanText(item['quote']) ?? cleanText(item['title']) ?? url ?? '';
    if (!quote) continue;

    const source = item['source'];
    normalized.push({
      articleId,
      quote,
      ...(cleanText(item['title']) ? { title: cleanText(item['title']) } : {}),
      ...(url ? { url } : {}),
      ...(source === 'article' || source === 'web_search' || source === 'news_search'
        ? { source }
        : {}),
    });
  }
  return dedupeCitations(normalized);
}

/** Extract citations Anthropic attached to text blocks after built-in web_search. */
export function collectAnthropicWebCitations(content: unknown): ChatCitation[] {
  if (!Array.isArray(content)) return [];

  const citations: ChatCitation[] = [];
  for (const block of content) {
    if (!isRecord(block) || !Array.isArray(block['citations'])) continue;
    for (const raw of block['citations']) {
      if (!isRecord(raw)) continue;
      const type = cleanText(raw['type']);
      const url = cleanUrl(raw['url']);
      if (!url || !type?.includes('web_search')) continue;
      const title = cleanText(raw['title']);
      citations.push({
        articleId: null,
        quote: cleanText(raw['cited_text']) ?? title ?? url,
        ...(title ? { title } : {}),
        url,
        source: 'web_search',
      });
    }
  }
  return dedupeCitations(citations);
}

export function collectTavilyCitationCandidates(value: unknown): ChatCitation[] {
  if (!isRecord(value) || !Array.isArray(value['results'])) return [];

  const citations: ChatCitation[] = [];
  for (const result of value['results']) {
    if (!isRecord(result)) continue;
    const url = cleanUrl(result['url']);
    if (!url) continue;
    const title = cleanText(result['title']);
    citations.push({
      articleId: null,
      quote: cleanText(result['content'])?.slice(0, 240) ?? title ?? url,
      ...(title ? { title } : {}),
      url,
      source: 'news_search',
    });
  }
  return dedupeCitations(citations);
}

function urlsInText(text: string): Set<string> {
  const urls = text.match(/https?:\/\/[^\s<>)\]}"']+/g) ?? [];
  return new Set(urls.map(canonicalUrl));
}

function mentionsArticle(text: string, id: number): boolean {
  const escapedId = String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (
    new RegExp(`\\[src\\s+${escapedId}\\]`, 'i').test(text) ||
    new RegExp(`\\barticle\\s*(?:#|id[:\\s]*)?${escapedId}\\b`, 'i').test(text)
  );
}

/**
 * Persist only sources with evidence in the final answer: Anthropic's explicit
 * citation metadata, Tavily URLs printed by the model, and retrieved article
 * IDs the model referenced as [src N].
 */
export function selectUsedChatCitations(input: {
  assistantText: string;
  explicitWeb: ChatCitation[];
  tavilyCandidates: ChatCitation[];
  articleCandidates: ArticleCitationCandidate[];
}): ChatCitation[] {
  const printedUrls = urlsInText(input.assistantText);
  const tavilyUsed = input.tavilyCandidates.filter(
    (candidate) => candidate.url && printedUrls.has(canonicalUrl(candidate.url)),
  );
  const articlesUsed = input.articleCandidates
    .filter((article) => mentionsArticle(input.assistantText, article.id))
    .map(
      (article): ChatCitation => ({
        articleId: article.id,
        quote: article.headline,
        title: article.headline,
        source: 'article',
      }),
    );

  return dedupeCitations([...input.explicitWeb, ...tavilyUsed, ...articlesUsed]);
}
