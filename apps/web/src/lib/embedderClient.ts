// Chat can still answer from structured context when semantic retrieval is
// unavailable. Keep that fallback genuinely interactive instead of waiting for
// Railway's private service to time out for a minute and a half.
const DEFAULT_TIMEOUT_MS = 25_000;
const EMBEDDING_DIM = 384;

interface EmbedderResponse {
  model: string;
  dimensions: number;
  vectors: number[][];
}

export function embedderConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env['EMBEDDER_URL']?.trim());
}

function embedderConfig(env: NodeJS.ProcessEnv = process.env): {
  url: string;
  secret: string | undefined;
} {
  const url = env['EMBEDDER_URL']?.trim().replace(/\/$/, '');
  if (!url) throw new Error('EMBEDDER_URL is not configured');
  const secret = env['EMBEDDER_SECRET']?.trim() || env['WORKER_SECRET']?.trim();
  return { url, secret };
}

export function validateEmbedderResponse(value: unknown, expectedCount: number): number[][] {
  if (!value || typeof value !== 'object') throw new Error('embedder returned invalid JSON');
  const response = value as Partial<EmbedderResponse>;
  if (response.dimensions !== EMBEDDING_DIM || !Array.isArray(response.vectors)) {
    throw new Error('embedder returned an invalid vector envelope');
  }
  if (response.vectors.length !== expectedCount) {
    throw new Error(
      `embedder returned ${response.vectors.length} vectors for ${expectedCount} inputs`,
    );
  }
  for (const vector of response.vectors) {
    if (
      !Array.isArray(vector) ||
      vector.length !== EMBEDDING_DIM ||
      !vector.every((part) => typeof part === 'number' && Number.isFinite(part))
    ) {
      throw new Error('embedder returned a malformed vector');
    }
  }
  return response.vectors;
}

export async function embedTexts(
  texts: string[],
  opts: {
    fetchImpl?: typeof fetch;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  } = {},
): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (texts.length > 32) throw new Error('embedder request is limited to 32 texts');
  if (texts.some((text) => !text.trim() || text.length > 12_000)) {
    throw new Error('embedder text must be between 1 and 12000 characters');
  }

  const { url, secret } = embedderConfig(opts.env);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (secret) headers['x-embedder-secret'] = secret;
  const response = await (opts.fetchImpl ?? fetch)(`${url}/v1/embeddings`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ texts }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`embedder rejected request (${response.status}): ${body.slice(0, 200)}`);
  }
  return validateEmbedderResponse(await response.json(), texts.length);
}

export async function embedText(text: string): Promise<number[]> {
  const vectors = await embedTexts([text]);
  const vector = vectors[0];
  if (!vector) throw new Error('embedder returned no vector');
  return vector;
}
