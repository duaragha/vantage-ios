/**
 * @vantage/embed
 *
 * Local embeddings via `@huggingface/transformers` running
 * `Xenova/bge-small-en-v1.5` (384-dim, CPU) + pgvector similarity-search
 * helpers for Article and ThesisEvaluation rows.
 *
 * Public surface:
 *   - `getEmbedder()`   — lazy singleton access to the underlying pipeline
 *   - `embed(text)`     — single string → 384-dim unit vector
 *   - `embedBatch`      — batch variant
 *   - `embedArticle` / `embedThesisEvaluation` — embed-on-write hooks
 *   - `searchArticles` / `searchThesisEvaluations` — pgvector cosine search
 *   - `EMBEDDING_DIM`   — 384 (exported as literal)
 *   - `EMBEDDING_MODEL` — model ID string
 */

export {
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
  embed,
  embedBatch,
  getEmbedder,
} from './embedder.js';

export { embedArticle, embedThesisEvaluation } from './hooks.js';

export {
  searchArticles,
  searchThesisEvaluations,
  type ArticleSearchHit,
  type SearchOpts,
  type ThesisEvaluationSearchHit,
} from './search.js';
