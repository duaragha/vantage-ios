/**
 * Watchlist CRUD helpers.
 */

import type { Watchlist } from '@prisma/client';
import { prisma } from './client.js';

export interface AddWatchlistInput {
  ticker: string;
  reason?: string | null;
  addedBy: 'user' | 'agent';
}

export function addToWatchlist(input: AddWatchlistInput): Promise<Watchlist> {
  const { ticker, reason, addedBy } = input;
  return prisma.watchlist.upsert({
    where: { ticker },
    create: { ticker, reason: reason ?? null, addedBy },
    update: { reason: reason ?? null, addedBy },
  });
}

export async function removeFromWatchlist(ticker: string): Promise<void> {
  await prisma.watchlist.deleteMany({ where: { ticker } });
}

export function listWatchlist(): Promise<Watchlist[]> {
  return prisma.watchlist.findMany({ orderBy: { addedAt: 'desc' } });
}
