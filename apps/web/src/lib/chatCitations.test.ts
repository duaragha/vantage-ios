import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  collectAnthropicWebCitations,
  collectTavilyCitationCandidates,
  normalizeStoredChatCitations,
  selectUsedChatCitations,
} from './chatCitations.ts';

describe('chat citations', () => {
  it('keeps legacy stored article citations readable', () => {
    assert.deepEqual(
      normalizeStoredChatCitations([{ articleId: 42, quote: 'A useful headline' }]),
      [{ articleId: 42, quote: 'A useful headline' }],
    );
  });

  it('extracts only Anthropic citations attached to text blocks', () => {
    const citations = collectAnthropicWebCitations([
      {
        type: 'text',
        text: 'Revenue grew.',
        citations: [
          {
            type: 'web_search_result_location',
            url: 'https://example.com/report',
            title: 'Company report',
            cited_text: 'Revenue grew by 12 percent.',
          },
        ],
      },
      {
        type: 'web_search_tool_result',
        content: [{ url: 'https://unused.example.com', title: 'Unused result' }],
      },
    ]);

    assert.deepEqual(citations, [
      {
        articleId: null,
        quote: 'Revenue grew by 12 percent.',
        title: 'Company report',
        url: 'https://example.com/report',
        source: 'web_search',
      },
    ]);
  });

  it('keeps only Tavily URLs and database articles cited in the final answer', () => {
    const candidates = collectTavilyCitationCandidates({
      results: [
        { title: 'Used', url: 'https://news.example.com/used', content: 'Used source' },
        { title: 'Ignored', url: 'https://news.example.com/ignored', content: 'Ignored source' },
      ],
    });
    const selected = selectUsedChatCitations({
      assistantText:
        'The filing changed the outlook [src 17]. Read [the report](https://news.example.com/used).',
      explicitWeb: [],
      tavilyCandidates: candidates,
      articleCandidates: [
        { id: 17, headline: 'Referenced filing' },
        { id: 18, headline: 'Unrelated article' },
      ],
    });

    assert.equal(selected.length, 2);
    assert.equal(selected[0]?.url, 'https://news.example.com/used');
    assert.equal(selected[1]?.articleId, 17);
  });

  it('deduplicates an explicit web citation and a matching Tavily URL', () => {
    const selected = selectUsedChatCitations({
      assistantText: 'Source: https://example.com/report',
      explicitWeb: [
        {
          articleId: null,
          quote: 'Explicit evidence',
          url: 'https://example.com/report',
          source: 'web_search',
        },
      ],
      tavilyCandidates: [
        {
          articleId: null,
          quote: 'Search snippet',
          url: 'https://example.com/report/',
          source: 'news_search',
        },
      ],
      articleCandidates: [],
    });

    assert.equal(selected.length, 1);
    assert.equal(selected[0]?.quote, 'Explicit evidence');
  });
});
