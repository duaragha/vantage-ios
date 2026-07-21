import assert from 'node:assert/strict';
import test from 'node:test';
import { embedTexts, embedderConfigured, validateEmbedderResponse } from './embedderClient.js';

const vector = Array.from({ length: 384 }, (_, index) => index / 384);

test('embedderConfigured requires an explicit service URL', () => {
  assert.equal(embedderConfigured({}), false);
  assert.equal(embedderConfigured({ EMBEDDER_URL: 'http://embedder:3002' }), true);
});

test('validateEmbedderResponse accepts finite 384-dimensional vectors', () => {
  assert.deepEqual(
    validateEmbedderResponse({ model: 'test', dimensions: 384, vectors: [vector] }, 1),
    [vector],
  );
});

test('validateEmbedderResponse rejects malformed vectors', () => {
  assert.throws(
    () => validateEmbedderResponse({ dimensions: 384, vectors: [[1, 2, 3]] }, 1),
    /malformed vector/,
  );
});

test('embedTexts authenticates and validates the remote response', async () => {
  let request: RequestInit | undefined;
  const fetchImpl: typeof fetch = async (_input, init) => {
    request = init;
    return new Response(JSON.stringify({ model: 'test', dimensions: 384, vectors: [vector] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await embedTexts(['hello'], {
    fetchImpl,
    env: { EMBEDDER_URL: 'http://embedder:3002/', EMBEDDER_SECRET: 'secret' },
  });
  assert.deepEqual(result, [vector]);
  assert.equal((request?.headers as Record<string, string>)['x-embedder-secret'], 'secret');
});
