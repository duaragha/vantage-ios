import { Prisma, prisma } from '@vantage/db';
import { EMBEDDING_DIM, embedBatch } from '@vantage/embed';

const ARTICLE_BODY_LIMIT = 2_000;
const MODEL_BATCH_SIZE = 16;

export interface PendingEmbeddingSummary {
  articlesEmbedded: number;
  thesisEvaluationsEmbedded: number;
  remainingArticles: number;
  remainingThesisEvaluations: number;
  runtimeMs: number;
}

interface ArticleRow {
  id: number;
  headline: string;
  body: string | null;
}

interface ThesisRow {
  id: number;
  rationale: string;
}

export function articleEmbeddingText(row: Pick<ArticleRow, 'headline' | 'body'>): string {
  const body = (row.body ?? '').slice(0, ARTICLE_BODY_LIMIT).trim();
  return body ? `${row.headline}\n\n${body}` : row.headline;
}

export function positiveInteger(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function vectorLiteral(vector: number[]): string {
  if (vector.length !== EMBEDDING_DIM || !vector.every(Number.isFinite)) {
    throw new Error(`embedder produced an invalid ${EMBEDDING_DIM}-dimensional vector`);
  }
  return `[${vector.join(',')}]`;
}

async function writeArticleVectors(rows: ArticleRow[], vectors: number[][]): Promise<void> {
  const operations = rows.map((row, index) => {
    const vector = vectors[index];
    if (!vector) throw new Error(`missing vector for Article ${row.id}`);
    const literal = vectorLiteral(vector);
    return prisma.$executeRaw`
      UPDATE "Article" SET "embedding" = ${literal}::vector WHERE "id" = ${row.id}
    `;
  });
  if (operations.length > 0) await prisma.$transaction(operations);
}

async function writeThesisVectors(rows: ThesisRow[], vectors: number[][]): Promise<void> {
  const operations = rows.map((row, index) => {
    const vector = vectors[index];
    if (!vector) throw new Error(`missing vector for ThesisEvaluation ${row.id}`);
    const literal = vectorLiteral(vector);
    return prisma.$executeRaw`
      UPDATE "ThesisEvaluation" SET "embedding" = ${literal}::vector WHERE "id" = ${row.id}
    `;
  });
  if (operations.length > 0) await prisma.$transaction(operations);
}

export async function embedRowsSafely<T>(
  rows: T[],
  render: (row: T) => string,
  write: (batchRows: T[], vectors: number[][]) => Promise<void>,
  opts: {
    embed?: typeof embedBatch;
    rowId: (row: T) => number;
    log?: Pick<Console, 'error'>;
  },
): Promise<number> {
  let completed = 0;
  for (let offset = 0; offset < rows.length; offset += MODEL_BATCH_SIZE) {
    const batchRows = rows.slice(offset, offset + MODEL_BATCH_SIZE);
    try {
      const vectors = await (opts.embed ?? embedBatch)(batchRows.map(render));
      await write(batchRows, vectors);
      completed += batchRows.length;
    } catch (err) {
      // Leave failed rows null so a later sweep can retry them, but continue
      // past this batch during the current run. Combined with the query cursor
      // below, one malformed row cannot wedge the entire durable queue.
      opts.log?.error(
        { err, rowIds: batchRows.map(opts.rowId) },
        'embedding batch failed; leaving rows pending for a later sweep',
      );
    }
  }
  return completed;
}

export async function processPendingEmbeddings(
  opts: {
    maxRows?: number;
    queryBatchSize?: number;
    log?: Pick<Console, 'info' | 'warn' | 'error'>;
  } = {},
): Promise<PendingEmbeddingSummary> {
  const startedAt = Date.now();
  const maxRows = Math.max(2, Math.min(opts.maxRows ?? 1_000, 10_000));
  const queryBatchSize = Math.max(1, Math.min(opts.queryBatchSize ?? 128, 500));
  const thesisBudget = Math.max(1, Math.floor(maxRows * 0.1));
  const articleBudget = maxRows - thesisBudget;
  let articlesEmbedded = 0;
  let thesisEvaluationsEmbedded = 0;
  let articlesAttempted = 0;
  let thesisEvaluationsAttempted = 0;
  let articleCursor = 0;
  let thesisCursor = 0;

  while (articlesAttempted < articleBudget) {
    const limit = Math.min(queryBatchSize, articleBudget - articlesAttempted);
    const rows = await prisma.$queryRaw<ArticleRow[]>(Prisma.sql`
      SELECT "id", "headline", "body"
      FROM "Article"
      WHERE "embedding" IS NULL AND "satireBlocked" = false AND "id" > ${articleCursor}
      ORDER BY "id" ASC
      LIMIT ${limit}
    `);
    if (rows.length === 0) break;
    articleCursor = rows.at(-1)?.id ?? articleCursor;
    articlesAttempted += rows.length;
    articlesEmbedded += await embedRowsSafely(rows, articleEmbeddingText, writeArticleVectors, {
      rowId: (row) => row.id,
      log: opts.log,
    });
    opts.log?.info({ articlesEmbedded }, 'embedded article batch');
    if (rows.length < limit) break;
  }

  while (thesisEvaluationsAttempted < thesisBudget) {
    const limit = Math.min(queryBatchSize, thesisBudget - thesisEvaluationsAttempted);
    const rows = await prisma.$queryRaw<ThesisRow[]>(Prisma.sql`
      SELECT "id", "rationale"
      FROM "ThesisEvaluation"
      WHERE "embedding" IS NULL AND "id" > ${thesisCursor}
      ORDER BY "id" ASC
      LIMIT ${limit}
    `);
    if (rows.length === 0) break;
    thesisCursor = rows.at(-1)?.id ?? thesisCursor;
    thesisEvaluationsAttempted += rows.length;
    thesisEvaluationsEmbedded += await embedRowsSafely(
      rows,
      (row) => row.rationale,
      writeThesisVectors,
      { rowId: (row) => row.id, log: opts.log },
    );
    opts.log?.info({ thesisEvaluationsEmbedded }, 'embedded thesis-evaluation batch');
    if (rows.length < limit) break;
  }

  const [remainingArticles, remainingThesisEvaluations] = await Promise.all([
    prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      SELECT count(*)::bigint AS count FROM "Article"
      WHERE "embedding" IS NULL AND "satireBlocked" = false
    `),
    prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      SELECT count(*)::bigint AS count FROM "ThesisEvaluation" WHERE "embedding" IS NULL
    `),
  ]);

  return {
    articlesEmbedded,
    thesisEvaluationsEmbedded,
    remainingArticles: Number(remainingArticles[0]?.count ?? 0n),
    remainingThesisEvaluations: Number(remainingThesisEvaluations[0]?.count ?? 0n),
    runtimeMs: Date.now() - startedAt,
  };
}
