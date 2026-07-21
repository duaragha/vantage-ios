import assert from 'node:assert/strict';
import test from 'node:test';
import { buildServer } from './server.js';

function withEmbedderSecret<T>(secret: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env['EMBEDDER_SECRET'];
  if (secret === undefined) delete process.env['EMBEDDER_SECRET'];
  else process.env['EMBEDDER_SECRET'] = secret;

  return run().finally(() => {
    if (previous === undefined) delete process.env['EMBEDDER_SECRET'];
    else process.env['EMBEDDER_SECRET'] = previous;
  });
}

test('health is public and describes the embedding contract', async () => {
  const server = buildServer();
  const response = await server.inject({ method: 'GET', url: '/health' });
  await server.close();

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().dimensions, 384);
});

test('embedding endpoint rejects a missing service secret', async () => {
  await withEmbedderSecret('expected-secret', async () => {
    const server = buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/v1/embeddings',
      payload: { texts: ['hello'] },
    });
    await server.close();

    assert.equal(response.statusCode, 401);
  });
});

test('embedding endpoint validates input before loading the model', async () => {
  await withEmbedderSecret('expected-secret', async () => {
    const server = buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: { 'x-embedder-secret': 'expected-secret' },
      payload: { texts: [] },
    });
    await server.close();

    assert.equal(response.statusCode, 400);
    assert.match(response.json().error, /texts must contain/);
  });
});
