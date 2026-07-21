/**
 * Article CRUD helpers — includes raw-SQL writer for the pgvector embedding column.
 */

import type { Article } from '@prisma/client';
import { prisma } from './client.js';

export interface UpsertArticleInput {
  sourceTier: number;
  source: string;
  domain?: string | null;
  url: string;
  headline: string;
  body?: string | null;
  publishedAt: Date;
  tickers: string[];
  clusterId?: string | null;
  trustedCitable?: boolean;
  satireBlocked?: boolean;
  socialSentiment?: 'Bullish' | 'Bearish' | null;
}

/**
 * Upsert by url (unique). Returns the row (new or existing, updated fields applied).
 */
export function upsertArticle(input: UpsertArticleInput): Promise<Article> {
  const {
    url,
    sourceTier,
    source,
    headline,
    body,
    publishedAt,
    tickers,
    domain,
    clusterId,
    trustedCitable,
    satireBlocked,
    socialSentiment,
  } = input;

  return prisma.article.upsert({
    where: { url },
    create: {
      sourceTier,
      source,
      domain: domain ?? null,
      url,
      headline,
      body: body ?? null,
      publishedAt,
      tickers,
      clusterId: clusterId ?? null,
      ...(trustedCitable !== undefined ? { trustedCitable } : {}),
      ...(satireBlocked !== undefined ? { satireBlocked } : {}),
      ...(socialSentiment !== undefined ? { socialSentiment } : {}),
    },
    update: {
      sourceTier,
      source,
      domain: domain ?? null,
      headline,
      body: body ?? null,
      publishedAt,
      tickers,
      clusterId: clusterId ?? null,
      ...(trustedCitable !== undefined ? { trustedCitable } : {}),
      ...(satireBlocked !== undefined ? { satireBlocked } : {}),
      ...(socialSentiment !== undefined ? { socialSentiment } : {}),
    },
  });
}

export function findArticlesByCluster(clusterId: string): Promise<Article[]> {
  return prisma.article.findMany({
    where: { clusterId },
    orderBy: { publishedAt: 'desc' },
  });
}

export interface FindArticlesByTickerInput {
  ticker: string;
  since?: Date;
  until?: Date;
  limit?: number;
}

export function findArticlesByTicker(
  input: FindArticlesByTickerInput,
): Promise<Article[]> {
  const { ticker, since, until, limit = 100 } = input;
  return prisma.article.findMany({
    where: {
      tickers: { has: ticker },
      ...(since || until
        ? {
            publishedAt: {
              ...(since ? { gte: since } : {}),
              ...(until ? { lte: until } : {}),
            },
          }
        : {}),
    },
    orderBy: { publishedAt: 'desc' },
    take: limit,
  });
}

/**
 * Overwrite the tickers[] column for an Article. Used by the ticker-extraction
 * step in pollMarketNews after regex/Haiku has resolved ticker set for a
 * market-wide article that was upserted with empty tickers.
 */
export function updateArticleTickers(
  articleId: number,
  tickers: string[],
): Promise<Article> {
  return prisma.article.update({
    where: { id: articleId },
    data: { tickers },
  });
}

/**
 * Write a 384-dim embedding to Article.embedding via raw SQL.
 * pgvector columns are Unsupported() in the Prisma client, so this is the only path.
 */
export async function writeArticleEmbedding(
  articleId: number,
  embedding: number[],
): Promise<void> {
  if (embedding.length !== 384) {
    throw new Error(`embedding must be 384-dim (got ${embedding.length})`);
  }
  const vectorLiteral = `[${embedding.join(',')}]`;
  await prisma.$executeRaw`
    UPDATE "Article"
    SET "embedding" = ${vectorLiteral}::vector
    WHERE "id" = ${articleId}
  `;
}

/**
 * Raw-SQL readback of the embedding column for a single article.
 * Returns null if no embedding is set.
 */
export async function readArticleEmbedding(
  articleId: number,
): Promise<number[] | null> {
  const rows = await prisma.$queryRaw<Array<{ embedding: string | null }>>`
    SELECT "embedding"::text AS embedding
    FROM "Article"
    WHERE "id" = ${articleId}
  `;
  const row = rows[0];
  if (!row || !row.embedding) return null;
  // pgvector returns a string like "[0.1,0.2,...]"
  const trimmed = row.embedding.trim();
  const stripped = trimmed.startsWith('[') && trimmed.endsWith(']')
    ? trimmed.slice(1, -1)
    : trimmed;
  return stripped.split(',').map((n) => Number.parseFloat(n));
}
