import assert from 'node:assert/strict';
import test from 'node:test';
import { articleEmbeddingText, embedRowsSafely, positiveInteger } from './pending.js';

test('articleEmbeddingText includes a bounded body', () => {
  const text = articleEmbeddingText({ headline: 'Headline', body: 'x'.repeat(3_000) });
  assert.equal(text.length, 'Headline\n\n'.length + 2_000);
});

test('articleEmbeddingText handles missing bodies', () => {
  assert.equal(articleEmbeddingText({ headline: 'Headline', body: null }), 'Headline');
});

test('positiveInteger bounds operator-provided values', () => {
  assert.equal(positiveInteger(undefined, 100, 500), 100);
  assert.equal(positiveInteger('-1', 100, 500), 100);
  assert.equal(positiveInteger('900', 100, 500), 500);
  assert.equal(positiveInteger('42', 100, 500), 42);
});

test('embedRowsSafely continues after a failed model batch', async () => {
  const rows = Array.from({ length: 17 }, (_, index) => ({ id: index + 1, text: `row ${index}` }));
  const written: number[] = [];
  const failed: number[][] = [];
  let calls = 0;

  const completed = await embedRowsSafely(
    rows,
    (row) => row.text,
    async (batchRows) => {
      written.push(...batchRows.map((row) => row.id));
    },
    {
      rowId: (row) => row.id,
      embed: async (texts) => {
        calls += 1;
        if (calls === 1) throw new Error('poison batch');
        return texts.map(() => Array.from({ length: 384 }, () => 0));
      },
      log: {
        error: (details) => failed.push((details as { rowIds: number[] }).rowIds),
      },
    },
  );

  assert.equal(completed, 1);
  assert.deepEqual(written, [17]);
  assert.deepEqual(failed, [Array.from({ length: 16 }, (_, index) => index + 1)]);
});
