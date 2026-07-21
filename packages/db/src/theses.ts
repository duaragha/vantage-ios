/**
 * Thesis + ThesisEvaluation CRUD helpers.
 */

import type { Prisma, Thesis, ThesisEvaluation, ThesisStatus } from '@prisma/client';
import { prisma } from './client.js';

export interface UpsertThesisInput {
  positionId: number;
  summary: string;
  pillars: Prisma.InputJsonValue;
  riskFactors: Prisma.InputJsonValue;
  status?: ThesisStatus;
}

export function upsertThesis(input: UpsertThesisInput): Promise<Thesis> {
  const { positionId, summary, pillars, riskFactors, status } = input;
  return prisma.thesis.upsert({
    where: { positionId },
    create: {
      positionId,
      summary,
      pillars,
      riskFactors,
      ...(status ? { status } : {}),
    },
    update: {
      summary,
      pillars,
      riskFactors,
      ...(status ? { status } : {}),
      lastValidatedAt: new Date(),
    },
  });
}

export function updateThesisStatus(
  thesisId: number,
  status: ThesisStatus,
): Promise<Thesis> {
  return prisma.thesis.update({
    where: { id: thesisId },
    data: { status, lastValidatedAt: new Date() },
  });
}

export function findThesisByPositionId(
  positionId: number,
): Promise<Thesis | null> {
  return prisma.thesis.findUnique({ where: { positionId } });
}

export interface RecordEvaluationInput {
  thesisId: number;
  prevStatus: ThesisStatus;
  newStatus: ThesisStatus;
  rationale: string;
  citations: Prisma.InputJsonValue;
}

export function recordThesisEvaluation(
  input: RecordEvaluationInput,
): Promise<ThesisEvaluation> {
  return prisma.thesisEvaluation.create({ data: input });
}

/**
 * Write embedding for a ThesisEvaluation row via raw SQL (pgvector column).
 * `embedding` must be a 384-dim float array.
 */
export async function writeThesisEvaluationEmbedding(
  evaluationId: number,
  embedding: number[],
): Promise<void> {
  if (embedding.length !== 384) {
    throw new Error(
      `embedding must be 384-dim (got ${embedding.length})`,
    );
  }
  const vectorLiteral = `[${embedding.join(',')}]`;
  await prisma.$executeRaw`
    UPDATE "ThesisEvaluation"
    SET "embedding" = ${vectorLiteral}::vector
    WHERE "id" = ${evaluationId}
  `;
}

export function listEvaluationsForThesis(
  thesisId: number,
  limit = 50,
): Promise<ThesisEvaluation[]> {
  return prisma.thesisEvaluation.findMany({
    where: { thesisId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}
