/**
 * Insight CRUD helpers.
 */

import type {
  Confidence,
  Insight,
  InsightKind,
  InsightStatus,
  Prisma,
} from '@prisma/client';
import { prisma } from './client.js';

export interface CreateInsightInput {
  kind: InsightKind;
  title: string;
  body: string;
  reasoning: string;
  citations: Prisma.InputJsonValue;
  actionJson?: Prisma.InputJsonValue | null;
  confidence: Confidence;
  triggeredBy: string;
  clusterId?: string | null;
}

export function createInsight(input: CreateInsightInput): Promise<Insight> {
  const { actionJson, clusterId, ...rest } = input;
  return prisma.insight.create({
    data: {
      ...rest,
      ...(actionJson !== undefined && actionJson !== null
        ? { actionJson }
        : {}),
      ...(clusterId !== undefined ? { clusterId } : {}),
    },
  });
}

/**
 * Update Insight.status (and optionally userFeedback) when the user acts on it.
 * Sets resolvedAt when moving to a terminal state (Bought/Passed/Snoozed).
 */
export function markInsightStatus(
  id: number,
  status: InsightStatus,
): Promise<Insight> {
  const terminal: InsightStatus[] = ['Bought', 'Passed', 'Snoozed'];
  const isTerminal = terminal.includes(status);
  const data: Prisma.InsightUpdateInput = { status };
  if (isTerminal) {
    data.resolvedAt = new Date();
    // UserFeedback enum values mirror the terminal InsightStatus values by name.
    data.userFeedback = status as unknown as Prisma.InsightUpdateInput['userFeedback'];
  }
  return prisma.insight.update({ where: { id }, data });
}

export function listNewInsights(limit = 100): Promise<Insight[]> {
  return prisma.insight.findMany({
    where: { status: 'New' },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

export function listInsightsByTicker(
  ticker: string,
  limit = 50,
): Promise<Insight[]> {
  // actionJson stores { ticker, ... } — filter via Prisma JSON path.
  return prisma.insight.findMany({
    where: {
      actionJson: {
        path: ['ticker'],
        equals: ticker,
      },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}
