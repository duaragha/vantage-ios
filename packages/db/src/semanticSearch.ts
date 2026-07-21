/**
 * Lightweight pgvector search helpers.
 *
 * Querying stored vectors belongs in the database package so web consumers do
 * not need to install the local ONNX model just to perform cosine searches.
 * Vector generation remains isolated in @vantage/embed / the embedder service.
 */

import { Prisma } from '@prisma/client';
import { prisma } from './client.js';

export const EMBEDDING_DIM = 384 as const;

export interface SemanticSearchOptions {
  k: number;
  tickers?: string[];
  sinceDays?: number;
}

export interface ArticleSemanticHit {
  id: number;
  headline: string;
  url: string;
  publishedAt: Date;
  tickers: string[];
  distance: number;
}

export interface ThesisEvaluationSemanticHit {
  id: number;
  thesisId: number;
  rationale: string;
  newStatus: string;
  createdAt: Date;
  distance: number;
}

function vectorLiteral(vector: number[]): string {
  if (vector.length !== EMBEDDING_DIM) {
    throw new Error(`expected ${EMBEDDING_DIM}-dim embedding, got ${vector.length}`);
  }
  if (!vector.every(Number.isFinite)) {
    throw new Error('embedding contains a non-finite value');
  }
  return `[${vector.join(',')}]`;
}

function validateOptions(opts: SemanticSearchOptions): void {
  if (!Number.isInteger(opts.k) || opts.k <= 0 || opts.k > 100) {
    throw new Error(`semantic search k must be an integer from 1 to 100, got ${opts.k}`);
  }
}

export async function searchArticlesByEmbedding(
  vector: number[],
  opts: SemanticSearchOptions,
): Promise<ArticleSemanticHit[]> {
  validateOptions(opts);
  const literal = vectorLiteral(vector);
  const filters: Prisma.Sql[] = [Prisma.sql`"embedding" IS NOT NULL`];
  if (opts.tickers && opts.tickers.length > 0) {
    filters.push(Prisma.sql`"tickers" && ${opts.tickers}::text[]`);
  }
  if (opts.sinceDays && opts.sinceDays > 0) {
    filters.push(Prisma.sql`"publishedAt" > now() - make_interval(days => ${opts.sinceDays})`);
  }

  const rows = await prisma.$queryRaw<
    Array<{
      id: number;
      headline: string;
      url: string;
      publishedAt: Date;
      tickers: string[];
      distance: number | string;
    }>
  >(Prisma.sql`
    SELECT "id", "headline", "url", "publishedAt", "tickers",
           ("embedding" <=> ${literal}::vector) AS distance
    FROM "Article"
    WHERE ${Prisma.join(filters, ' AND ')}
    ORDER BY "embedding" <=> ${literal}::vector ASC
    LIMIT ${opts.k}
  `);

  return rows.map((row) => ({ ...row, distance: Number(row.distance) }));
}

export async function searchThesisEvaluationsByEmbedding(
  vector: number[],
  opts: SemanticSearchOptions,
): Promise<ThesisEvaluationSemanticHit[]> {
  validateOptions(opts);
  const literal = vectorLiteral(vector);
  const filters: Prisma.Sql[] = [Prisma.sql`te."embedding" IS NOT NULL`];
  if (opts.tickers && opts.tickers.length > 0) {
    filters.push(Prisma.sql`p."ticker" = ANY(${opts.tickers}::text[])`);
  }
  if (opts.sinceDays && opts.sinceDays > 0) {
    filters.push(Prisma.sql`te."createdAt" > now() - make_interval(days => ${opts.sinceDays})`);
  }

  const rows = await prisma.$queryRaw<
    Array<{
      id: number;
      thesisId: number;
      rationale: string;
      newStatus: string;
      createdAt: Date;
      distance: number | string;
    }>
  >(Prisma.sql`
    SELECT te."id", te."thesisId", te."rationale", te."newStatus"::text AS "newStatus",
           te."createdAt", (te."embedding" <=> ${literal}::vector) AS distance
    FROM "ThesisEvaluation" te
    INNER JOIN "Thesis" t ON t."id" = te."thesisId"
    INNER JOIN "Position" p ON p."id" = t."positionId"
    WHERE ${Prisma.join(filters, ' AND ')}
    ORDER BY te."embedding" <=> ${literal}::vector ASC
    LIMIT ${opts.k}
  `);

  return rows.map((row) => ({ ...row, distance: Number(row.distance) }));
}
