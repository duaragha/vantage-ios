/**
 * Embed-on-write hooks.
 *
 * Each hook takes the row id + the text fields used to build the embedding
 * input, runs the local embedder, and writes the resulting 384-dim vector to
 * the `embedding` column via raw SQL (pgvector columns are Unsupported() in
 * the Prisma client, so raw SQL with an explicit `::vector` cast is the only
 * path).
 *
 * Writes are UPDATE-by-id — the caller is responsible for having created the
 * row first.
 */

import { prisma } from '@vantage/db';
import { embed, EMBEDDING_DIM } from './embedder.js';

/** Max body chars mixed into the article embedding input. */
const ARTICLE_BODY_CHAR_LIMIT = 2000;

/**
 * Compose headline + body (truncated), embed, and write to
 * `Article.embedding`. Idempotent — running twice just overwrites with the
 * same vector.
 */
export async function embedArticle(
  articleId: number,
  headline: string,
  body?: string | null,
): Promise<void> {
  const trimmedBody = (body ?? '').slice(0, ARTICLE_BODY_CHAR_LIMIT);
  const input = trimmedBody
    ? `${headline}\n\n${trimmedBody}`
    : headline;

  const vector = await embed(input);
  await writeVector('Article', articleId, vector);
}

/**
 * Embed the rationale field for a ThesisEvaluation row and write to its
 * `embedding` column. Rationale tends to be short (a paragraph), so no
 * composition needed.
 */
export async function embedThesisEvaluation(
  evalId: number,
  rationale: string,
): Promise<void> {
  const vector = await embed(rationale);
  await writeVector('ThesisEvaluation', evalId, vector);
}

/**
 * Shared vector-write helper. Uses `$executeRaw` with the vector literal
 * interpolated via parameterized SQL — pgvector accepts `'[x,y,z]'::vector`
 * as its text format.
 *
 * Table name is passed as a whitelisted literal, not a parameter, because
 * Postgres does not allow identifiers to be parameterized. We only call this
 * from two places, both with constant table names.
 */
async function writeVector(
  table: 'Article' | 'ThesisEvaluation',
  id: number,
  vector: number[],
): Promise<void> {
  if (vector.length !== EMBEDDING_DIM) {
    throw new Error(
      `writeVector: expected ${EMBEDDING_DIM}-dim, got ${vector.length}`,
    );
  }
  const literal = `[${vector.join(',')}]`;

  // Prisma's tagged-template $executeRaw only supports parameters for values,
  // not identifiers — hence the two branches. Both paths parameterize the
  // vector literal and id; only the identifier is hard-coded.
  if (table === 'Article') {
    await prisma.$executeRaw`
      UPDATE "Article"
      SET "embedding" = ${literal}::vector
      WHERE "id" = ${id}
    `;
  } else {
    await prisma.$executeRaw`
      UPDATE "ThesisEvaluation"
      SET "embedding" = ${literal}::vector
      WHERE "id" = ${id}
    `;
  }
}
