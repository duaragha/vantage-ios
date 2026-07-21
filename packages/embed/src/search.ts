/**
 * pgvector similarity-search helpers.
 *
 * Uses the `<=>` cosine-distance operator from pgvector. Because bge vectors
 * are L2-normalized, cosine distance == 1 - dot product; smaller is closer.
 *
 * Why raw SQL: pgvector columns are `Unsupported()` in the Prisma schema, so
 * we can't use the query builder. We also need the `<=>` operator, which is
 * operator-class-specific and wouldn't be expressible through Prisma anyway.
 */

import { Prisma } from '@vantage/db';
import { prisma } from '@vantage/db';
import { EMBEDDING_DIM } from './embedder.js';

export interface SearchOpts {
  /** How many rows to return. Required — don't default silently. */
  k: number;
  /**
   * If provided, only return rows whose `tickers[]` overlaps this list
   * (pgvector `&&` array operator). Empty list is treated as "no filter"
   * to avoid accidentally returning zero rows when a caller forgets.
   */
  tickers?: string[];
  /**
   * If provided, only return rows published within this many days.
   * `undefined` means no time filter.
   */
  sinceDays?: number;
}

export interface ArticleSearchHit {
  id: number;
  headline: string;
  url: string;
  publishedAt: Date;
  tickers: string[];
  /** Cosine distance in [0, 2]; 0 == identical direction. */
  distance: number;
}

export interface ThesisEvaluationSearchHit {
  id: number;
  thesisId: number;
  rationale: string;
  newStatus: string;
  createdAt: Date;
  distance: number;
}

/** Format a number[] as pgvector's text literal: `[x,y,z]`. */
function toVectorLiteral(vec: number[]): string {
  if (vec.length !== EMBEDDING_DIM) {
    throw new Error(
      `searchArticles: expected ${EMBEDDING_DIM}-dim, got ${vec.length}`,
    );
  }
  return `[${vec.join(',')}]`;
}

/**
 * Cosine-similarity search over Article.embedding.
 *
 * Ordered by distance ascending (closest first). Rows with a NULL embedding
 * are excluded.
 */
export async function searchArticles(
  queryEmbedding: number[],
  opts: SearchOpts,
): Promise<ArticleSearchHit[]> {
  const { k, tickers, sinceDays } = opts;
  if (!Number.isInteger(k) || k <= 0) {
    throw new Error(`searchArticles: k must be a positive integer, got ${k}`);
  }

  const literal = toVectorLiteral(queryEmbedding);

  // Build optional filters. Each is a Prisma.Sql fragment — concatenated
  // into the final query with `Prisma.join`/`Prisma.empty` for safety.
  const filters: Prisma.Sql[] = [Prisma.sql`"embedding" IS NOT NULL`];

  if (tickers && tickers.length > 0) {
    filters.push(Prisma.sql`"tickers" && ${tickers}::text[]`);
  }
  if (typeof sinceDays === 'number' && sinceDays > 0) {
    // `make_interval(days => N)` avoids the pitfall where interpolating into
    // `INTERVAL 'N days'` doesn't type-check.
    filters.push(
      Prisma.sql`"publishedAt" > now() - make_interval(days => ${sinceDays})`,
    );
  }

  const whereSql = Prisma.sql`WHERE ${Prisma.join(filters, ' AND ')}`;

  const rows = await prisma.$queryRaw<
    Array<{
      id: number;
      headline: string;
      url: string;
      publishedAt: Date;
      tickers: string[];
      distance: number;
    }>
  >(Prisma.sql`
    SELECT
      "id",
      "headline",
      "url",
      "publishedAt",
      "tickers",
      ("embedding" <=> ${literal}::vector) AS distance
    FROM "Article"
    ${whereSql}
    ORDER BY "embedding" <=> ${literal}::vector ASC
    LIMIT ${k}
  `);

  // Postgres returns `distance` as a string when it comes through some
  // drivers — normalize to number defensively.
  return rows.map((r) => ({
    ...r,
    distance: typeof r.distance === 'string' ? Number(r.distance) : r.distance,
  }));
}

/**
 * Cosine-similarity search over ThesisEvaluation.embedding.
 *
 * `tickers` is resolved via the parent Thesis → Position join. If omitted,
 * no ticker filter is applied.
 */
export async function searchThesisEvaluations(
  queryEmbedding: number[],
  opts: SearchOpts,
): Promise<ThesisEvaluationSearchHit[]> {
  const { k, tickers, sinceDays } = opts;
  if (!Number.isInteger(k) || k <= 0) {
    throw new Error(
      `searchThesisEvaluations: k must be a positive integer, got ${k}`,
    );
  }

  const literal = toVectorLiteral(queryEmbedding);

  const filters: Prisma.Sql[] = [Prisma.sql`te."embedding" IS NOT NULL`];

  if (typeof sinceDays === 'number' && sinceDays > 0) {
    filters.push(
      Prisma.sql`te."createdAt" > now() - make_interval(days => ${sinceDays})`,
    );
  }

  // Ticker filter requires joining Thesis → Position to get the ticker.
  // We always emit the join so the query shape is stable; the ticker filter
  // is only appended when `tickers` is non-empty.
  const joinSql = Prisma.sql`
    INNER JOIN "Thesis" t ON t."id" = te."thesisId"
    INNER JOIN "Position" p ON p."id" = t."positionId"
  `;

  if (tickers && tickers.length > 0) {
    filters.push(Prisma.sql`p."ticker" = ANY(${tickers}::text[])`);
  }

  const whereSql = Prisma.sql`WHERE ${Prisma.join(filters, ' AND ')}`;

  const rows = await prisma.$queryRaw<
    Array<{
      id: number;
      thesisId: number;
      rationale: string;
      newStatus: string;
      createdAt: Date;
      distance: number;
    }>
  >(Prisma.sql`
    SELECT
      te."id",
      te."thesisId",
      te."rationale",
      te."newStatus"::text AS "newStatus",
      te."createdAt",
      (te."embedding" <=> ${literal}::vector) AS distance
    FROM "ThesisEvaluation" te
    ${joinSql}
    ${whereSql}
    ORDER BY te."embedding" <=> ${literal}::vector ASC
    LIMIT ${k}
  `);

  return rows.map((r) => ({
    ...r,
    distance: typeof r.distance === 'string' ? Number(r.distance) : r.distance,
  }));
}
