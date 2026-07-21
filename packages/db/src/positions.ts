/**
 * Position CRUD helpers — no business logic, just DB access.
 *
 * Multi-account model: Position rows are uniquely identified by (accountId, ticker).
 * The same ticker held in two accounts is two rows. Lookup helpers come in two
 * flavours:
 *   - `findPositionByTicker(accountId, ticker)` — strict, returns the single lot
 *     in a given account (uses the composite unique).
 *   - `findPositionsByTicker(ticker)` — account-agnostic; returns every open or
 *     closed lot across accounts. Use when the caller doesn't yet know which
 *     account the lot lives in (e.g. legacy ticker-keyed routes).
 */

import type { Position, Prisma } from '@prisma/client';
import { prisma } from './client.js';

export interface CreatePositionInput {
  accountId: number;
  ticker: string;
  shares: Prisma.Decimal | number | string;
  avgCost: Prisma.Decimal | number | string;
  category: string;
  sector?: string | null;
  notes?: string | null;
}

export interface UpdatePositionInput {
  shares?: Prisma.Decimal | number | string;
  avgCost?: Prisma.Decimal | number | string;
  category?: string;
  sector?: string | null;
  notes?: string | null;
}

export function createPosition(input: CreatePositionInput): Promise<Position> {
  return prisma.position.create({ data: input });
}

export function updatePosition(
  id: number,
  input: UpdatePositionInput,
): Promise<Position> {
  return prisma.position.update({ where: { id }, data: input });
}

export function closePosition(
  id: number,
  closedAt: Date = new Date(),
): Promise<Position> {
  return prisma.position.update({ where: { id }, data: { closedAt } });
}

export function findPositionByTicker(
  accountId: number,
  ticker: string,
): Promise<Position | null> {
  return prisma.position.findUnique({
    where: { accountId_ticker: { accountId, ticker } },
  });
}

/**
 * All positions matching `ticker`, across every account, open or closed.
 * Sorted by account ID ascending so callers that pick `[0]` get a stable
 * "first known lot" for legacy single-result code paths.
 */
export function findPositionsByTicker(ticker: string): Promise<Position[]> {
  return prisma.position.findMany({
    where: { ticker },
    orderBy: { accountId: 'asc' },
  });
}

export function listOpenPositions(): Promise<Position[]> {
  return prisma.position.findMany({
    where: { closedAt: null },
    orderBy: { ticker: 'asc' },
  });
}

export function listAllPositions(): Promise<Position[]> {
  return prisma.position.findMany({ orderBy: { ticker: 'asc' } });
}

export function deletePosition(id: number): Promise<Position> {
  return prisma.position.delete({ where: { id } });
}
