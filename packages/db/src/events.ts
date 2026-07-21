/**
 * MarketEvent CRUD helpers.
 */

import type { EventKind, MarketEvent, Prisma } from '@prisma/client';
import { prisma } from './client.js';

export interface CreateMarketEventInput {
  kind: EventKind;
  ticker?: string | null;
  payload: Prisma.InputJsonValue;
  occurredAt: Date;
}

export function createMarketEvent(
  input: CreateMarketEventInput,
): Promise<MarketEvent> {
  const { kind, ticker, payload, occurredAt } = input;
  return prisma.marketEvent.create({
    data: {
      kind,
      ticker: ticker ?? null,
      payload,
      occurredAt,
    },
  });
}

export function markMarketEventProcessed(
  id: number,
  processedAt: Date = new Date(),
): Promise<MarketEvent> {
  return prisma.marketEvent.update({
    where: { id },
    data: { processedAt },
  });
}

export function findUnprocessedMarketEvents(
  limit = 100,
): Promise<MarketEvent[]> {
  return prisma.marketEvent.findMany({
    where: { processedAt: null },
    orderBy: { occurredAt: 'asc' },
    take: limit,
  });
}
