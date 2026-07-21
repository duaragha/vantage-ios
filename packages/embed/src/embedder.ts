/**
 * Local embedder — wraps `@huggingface/transformers` (v4, the successor to
 * `@xenova/transformers`) to run `Xenova/bge-small-en-v1.5` on CPU.
 *
 * BGE family models are trained with mean-pooling + L2-normalization; that
 * produces unit-length vectors where cosine similarity == dot product, which
 * is what pgvector's `<=>` operator expects for sane ranking.
 *
 * The underlying pipeline is a singleton — loaded once per process (the model
 * weights are ~130 MB and tokenizer init isn't free).
 *
 * Transformers.js v4 defaults to a `.cache` directory beside its installed
 * package, which is read-only in the production image. Production sets an
 * explicit writable cache directory under the `node` user's home instead.
 */

import {
  env,
  pipeline,
  type FeatureExtractionPipeline,
  type ProgressInfo,
} from '@huggingface/transformers';

export const EMBEDDING_DIM = 384 as const;
export const EMBEDDING_MODEL = 'Xenova/bge-small-en-v1.5' as const;

const configuredCacheDir = process.env['TRANSFORMERS_CACHE_DIR']?.trim();
if (configuredCacheDir) {
  env.cacheDir = configuredCacheDir;
}

/**
 * Soft word-count cap used to truncate input before passing to the tokenizer.
 * bge-small-en-v1.5 has a hard 512-token limit; 400 English words is a safe
 * upper bound (english words ≈ 1.3 tokens on average for this tokenizer).
 * This is a belt-and-suspenders guard — the pipeline is also called with
 * `truncation: true`, which enforces the token limit inside the tokenizer.
 */
const MAX_INPUT_WORDS = 400;

let pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

function logProgress(info: ProgressInfo): void {
  // Progress is fired repeatedly during the initial model download.
  // Keep output to stderr so it doesn't pollute stdout-as-data pipelines.
  if (info.status === 'progress') {
    // `progress` is a 0..100 number, `file` is the artifact being fetched.
    const file = 'file' in info ? info.file : '';
    const progress =
      'progress' in info && typeof info.progress === 'number' ? info.progress.toFixed(1) : '?';
    process.stderr.write(`[embed] downloading ${file}: ${progress}%\r`);
  } else if (info.status === 'done') {
    const file = 'file' in info ? info.file : '';
    process.stderr.write(`\n[embed] done: ${file}\n`);
  } else if (info.status === 'ready') {
    process.stderr.write(`[embed] model ready: ${EMBEDDING_MODEL}\n`);
  }
}

/**
 * Lazily load the feature-extraction pipeline. Subsequent calls return the
 * same promise, so the model is only loaded once per process.
 */
export function getEmbedder(): Promise<FeatureExtractionPipeline> {
  if (!pipelinePromise) {
    process.stderr.write(`[embed] loading ${EMBEDDING_MODEL} (first run may download ~130 MB)\n`);
    pipelinePromise = pipeline('feature-extraction', EMBEDDING_MODEL, {
      progress_callback: logProgress,
      // CPU only. Explicit to avoid surprises on machines with a GPU.
      device: 'cpu',
    }) as Promise<FeatureExtractionPipeline>;
  }
  return pipelinePromise;
}

/** Truncate input to `MAX_INPUT_WORDS` whitespace-separated tokens. */
function truncateWords(text: string): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= MAX_INPUT_WORDS) return text.trim();
  return words.slice(0, MAX_INPUT_WORDS).join(' ');
}

/**
 * Embed a single string → 384-dim unit-length float array.
 *
 * `pooling: 'mean'` + `normalize: true` are required for bge — the HF model
 * card is explicit about this. Without normalization, cosine similarity
 * rankings degrade noticeably.
 */
export async function embed(text: string): Promise<number[]> {
  const [vec] = await embedBatch([text]);
  if (!vec) {
    throw new Error('embed: pipeline returned no vector');
  }
  return vec;
}

/**
 * Embed a batch of strings. More efficient than calling `embed()` in a loop
 * — transformers.js batches internally through ONNX Runtime.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const extractor = await getEmbedder();
  const prepared = texts.map(truncateWords);

  const output = await extractor(prepared, {
    pooling: 'mean',
    normalize: true,
  });

  // `output` is a Tensor with shape [batch, dim]. `.tolist()` returns nested
  // JS arrays.
  const list = output.tolist() as number[][];

  if (list.length !== texts.length) {
    throw new Error(`embedBatch: expected ${texts.length} vectors, got ${list.length}`);
  }
  for (const v of list) {
    if (v.length !== EMBEDDING_DIM) {
      throw new Error(`embedBatch: expected ${EMBEDDING_DIM}-dim, got ${v.length}`);
    }
  }

  return list;
}
