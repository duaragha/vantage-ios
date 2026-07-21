/**
 * DiscoveryScore CRUD helpers.
 *
 * Append-only table. Nightly computeDiscovery writes a row per scored ticker;
 * the consumer layer (rotation digest, /discovery page) reads the latest
 * snapshot via `latestTopN` and historical trends via `latestForTicker`.
 */

import type { DiscoveryScore, Prisma } from '@prisma/client';
import { prisma } from './client.js';

export interface WriteDiscoveryScoreInput {
  ticker: string;
  score: number;
  signalBreakdown: Prisma.InputJsonValue;
  computedAt?: Date;
}

/**
 * Bulk-write a batch of discovery scores. All rows share the same `computedAt`
 * by default (the time of the compute job kick-off) so `latestTopN` can slice
 * by a single timestamp to get the most recent run.
 */
export async function writeBatch(
  scores: readonly WriteDiscoveryScoreInput[],
  defaultComputedAt: Date = new Date(),
): Promise<number> {
  if (scores.length === 0) return 0;
  const data = scores.map((s) => ({
    ticker: s.ticker.toUpperCase(),
    score: s.score,
    signalBreakdown: s.signalBreakdown,
    computedAt: s.computedAt ?? defaultComputedAt,
  }));
  const res = await prisma.discoveryScore.createMany({ data });
  return res.count;
}

export interface LatestTopNOptions {
  /** Tickers to exclude from the result (e.g. currently-held positions). */
  excludeTickers?: readonly string[];
  /** Minimum score (inclusive). Defaults to `-Infinity`. */
  minScore?: number;
}

/**
 * Return the top-N DiscoveryScore rows from the most-recent compute batch.
 *
 * "Most recent" is defined as the rows that share the maximum `computedAt`
 * value — the nightly job writes all its output with the same timestamp, so
 * this yields one row per ticker without needing a distinct-on query.
 */
export async function latestTopN(
  n: number,
  opts: LatestTopNOptions = {},
): Promise<DiscoveryScore[]> {
  const latest = await prisma.discoveryScore.aggregate({
    _max: { computedAt: true },
  });
  const computedAt = latest._max.computedAt;
  if (!computedAt) return [];

  const excluded = new Set(
    (opts.excludeTickers ?? []).map((t) => t.toUpperCase()),
  );
  const minScore = opts.minScore ?? Number.NEGATIVE_INFINITY;

  const rows = await prisma.discoveryScore.findMany({
    where: {
      computedAt,
      ...(excluded.size > 0
        ? { ticker: { notIn: [...excluded] } }
        : {}),
      ...(Number.isFinite(minScore) ? { score: { gte: minScore } } : {}),
    },
    orderBy: { score: 'desc' },
    take: n,
  });

  return rows;
}

/** All historical scores for a single ticker, newest first. */
export function latestForTicker(
  ticker: string,
  limit = 30,
): Promise<DiscoveryScore[]> {
  return prisma.discoveryScore.findMany({
    where: { ticker: ticker.toUpperCase() },
    orderBy: { computedAt: 'desc' },
    take: limit,
  });
}

/**
 * Delete DiscoveryScore rows older than `days` days. Returns the count purged.
 * Called at the tail of every compute run to enforce the 30-day retention window.
 */
export async function purgeOlderThan(days: number): Promise<number> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const res = await prisma.discoveryScore.deleteMany({
    where: { computedAt: { lt: cutoff } },
  });
  return res.count;
}
