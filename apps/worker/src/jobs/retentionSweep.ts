/**
 * Nightly retention sweep — bounded deletion of operational exhaust.
 *
 * Windows and rationale live in ../lib/retentionPolicy.ts. Runs at 03:30 ET
 * (after the fundamentals/lottery/goals nightly chain) via cron `db.retention`.
 *
 * Safety properties:
 *   - product tables are never touched
 *   - JobRun keeps the newest row per name regardless of age
 *   - pending/sending Telegram and app-notification deliveries are never touched
 *   - cited articles are never deleted (Insight + ChatMessage citations)
 *   - every delete is capped per table per run (MAX_DELETES_PER_TABLE)
 */

import { AppNotificationDeliveryStatus, prisma, TelegramDeliveryStatus } from '@vantage/db';
import { CATALYST_KINDS } from '@vantage/core';
import type { FastifyBaseLogger } from 'fastify';
import {
  MAX_DELETES_PER_TABLE,
  retentionCutoffs,
  type RetentionCutoffs,
} from '../lib/retentionPolicy.js';

export interface RetentionSweepResult {
  jobRunsDeleted: number;
  telegramDeliveriesDeleted: number;
  appNotificationDeliveriesDeleted: number;
  llmCallsDeleted: number;
  marketEventsDeleted: number;
  tier3ArticlesDeleted: number;
  catalystEventsDrained: number;
}

async function deleteOldJobRuns(cutoffs: RetentionCutoffs): Promise<number> {
  // Keep the newest JobRun per name — the ops page, watchdog and deep health
  // all treat "latest row per name" as the source of truth for last activity.
  const newestPerName = await prisma.jobRun.groupBy({
    by: ['name'],
    _max: { id: true },
  });
  const keepIds = newestPerName
    .map((row) => row._max.id)
    .filter((id): id is number => typeof id === 'number');

  const candidates = await prisma.jobRun.findMany({
    where: {
      id: { notIn: keepIds },
      OR: [
        { status: 'succeeded', startedAt: { lt: cutoffs.jobRunSucceededBefore } },
        { status: 'failed', startedAt: { lt: cutoffs.jobRunFailedBefore } },
      ],
    },
    select: { id: true },
    orderBy: { id: 'asc' },
    take: MAX_DELETES_PER_TABLE,
  });
  if (candidates.length === 0) return 0;
  const res = await prisma.jobRun.deleteMany({
    where: { id: { in: candidates.map((c) => c.id) } },
  });
  return res.count;
}

async function deleteOldTelegramDeliveries(cutoffs: RetentionCutoffs): Promise<number> {
  const candidates = await prisma.telegramDelivery.findMany({
    where: {
      OR: [
        { status: TelegramDeliveryStatus.Sent, sentAt: { lt: cutoffs.telegramSentBefore } },
        { status: TelegramDeliveryStatus.Dead, updatedAt: { lt: cutoffs.telegramDeadBefore } },
      ],
    },
    select: { id: true },
    orderBy: { id: 'asc' },
    take: MAX_DELETES_PER_TABLE,
  });
  if (candidates.length === 0) return 0;
  const res = await prisma.telegramDelivery.deleteMany({
    where: { id: { in: candidates.map((c) => c.id) } },
  });
  return res.count;
}

async function deleteOldAppNotificationDeliveries(cutoffs: RetentionCutoffs): Promise<number> {
  const candidates = await prisma.appNotificationDelivery.findMany({
    where: {
      OR: [
        {
          status: AppNotificationDeliveryStatus.Sent,
          sentAt: { lt: cutoffs.appNotificationSentBefore },
        },
        {
          status: AppNotificationDeliveryStatus.Dead,
          updatedAt: { lt: cutoffs.appNotificationDeadBefore },
        },
      ],
    },
    select: { id: true },
    orderBy: { id: 'asc' },
    take: MAX_DELETES_PER_TABLE,
  });
  if (candidates.length === 0) return 0;
  const res = await prisma.appNotificationDelivery.deleteMany({
    where: { id: { in: candidates.map((candidate) => candidate.id) } },
  });
  return res.count;
}

async function deleteOldLlmCalls(cutoffs: RetentionCutoffs): Promise<number> {
  const candidates = await prisma.llmCall.findMany({
    where: { createdAt: { lt: cutoffs.llmCallBefore } },
    select: { id: true },
    orderBy: { id: 'asc' },
    take: MAX_DELETES_PER_TABLE,
  });
  if (candidates.length === 0) return 0;
  const res = await prisma.llmCall.deleteMany({
    where: { id: { in: candidates.map((c) => c.id) } },
  });
  return res.count;
}

async function deleteOldProcessedMarketEvents(cutoffs: RetentionCutoffs): Promise<number> {
  const candidates = await prisma.marketEvent.findMany({
    where: {
      processedAt: { not: null },
      createdAt: { lt: cutoffs.marketEventProcessedBefore },
    },
    select: { id: true },
    orderBy: { id: 'asc' },
    take: MAX_DELETES_PER_TABLE,
  });
  if (candidates.length === 0) return 0;
  const res = await prisma.marketEvent.deleteMany({
    where: { id: { in: candidates.map((c) => c.id) } },
  });
  return res.count;
}

/**
 * Delete old tier-3 social posts that nothing cites. Citations live as
 * `[{ articleId, quote }]` JSON on Insight (required) and ChatMessage
 * (nullable), so the guard is a NOT EXISTS against both, tolerant of
 * non-array JSON.
 */
async function deleteOldUncitedTier3Articles(cutoffs: RetentionCutoffs): Promise<number> {
  const deleted = await prisma.$executeRaw`
    DELETE FROM "Article"
    WHERE "id" IN (
      SELECT a."id"
      FROM "Article" a
      WHERE a."sourceTier" = 3
        AND a."publishedAt" < ${cutoffs.tier3ArticleBefore}
        AND NOT EXISTS (
          SELECT 1
          FROM "Insight" i
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(i."citations") = 'array'
                 THEN i."citations" ELSE '[]'::jsonb END
          ) AS c(entry)
          WHERE (c.entry ->> 'articleId')::int = a."id"
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "ChatMessage" m
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN m."citations" IS NOT NULL AND jsonb_typeof(m."citations") = 'array'
                 THEN m."citations" ELSE '[]'::jsonb END
          ) AS c(entry)
          WHERE (c.entry ->> 'articleId')::int = a."id"
        )
      ORDER BY a."id" ASC
      LIMIT ${MAX_DELETES_PER_TABLE}
    )
  `;
  return deleted;
}

/**
 * Catalyst-kind events the engine never consumed (skipped by its quality /
 * conjunction / cooldown gates) age out of its 24h window and would otherwise
 * sit unprocessed forever now that the alert dispatcher leaves them alone.
 */
async function drainExpiredCatalystEvents(cutoffs: RetentionCutoffs): Promise<number> {
  const res = await prisma.marketEvent.updateMany({
    where: {
      kind: { in: [...CATALYST_KINDS] },
      processedAt: null,
      occurredAt: { lt: cutoffs.catalystEventDrainBefore },
    },
    data: { processedAt: new Date() },
  });
  return res.count;
}

export async function retentionSweep(
  log: FastifyBaseLogger | Console = console,
  opts: { now?: Date } = {},
): Promise<RetentionSweepResult> {
  const cutoffs = retentionCutoffs(opts.now ?? new Date());

  const result: RetentionSweepResult = {
    jobRunsDeleted: await deleteOldJobRuns(cutoffs),
    telegramDeliveriesDeleted: await deleteOldTelegramDeliveries(cutoffs),
    appNotificationDeliveriesDeleted: await deleteOldAppNotificationDeliveries(cutoffs),
    llmCallsDeleted: await deleteOldLlmCalls(cutoffs),
    marketEventsDeleted: await deleteOldProcessedMarketEvents(cutoffs),
    tier3ArticlesDeleted: await deleteOldUncitedTier3Articles(cutoffs),
    catalystEventsDrained: await drainExpiredCatalystEvents(cutoffs),
  };

  log.info?.(result, 'db.retention: sweep complete');
  return result;
}
