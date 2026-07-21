/**
 * Nightly snapshot of every non-archived goal's progress + remaining
 * contribution room.
 *
 * Runs once per Toronto calendar day. Each tick:
 *   1. Loads every non-archived Goal with its GoalPosition rows + the host
 *      account so we can compute a CAD-converted value of the linked shares.
 *   2. Bulk-loads the latest DailyBar for every linked ticker in a single
 *      `getLatestBarsForTickers` call so we don't N+1 on closes.
 *   3. Fetches the current USD→CAD rate once for the whole run.
 *   4. For each goal: sums `shares × close × allocation`, CAD-converting USD
 *      account values via the rate.
 *   5. Computes `roomCad` — the sum of `contributionRoomCad` across the
 *      non-archived accounts whose AccountType matches the goal's
 *      engine-recommended top type. Null when no candidate account has a
 *      defined room.
 *   6. Upserts a GoalSnapshot row keyed on (goalId, today ET date). The
 *      schema's `@@unique([goalId, date])` constraint means re-running the
 *      job same-day silently overwrites the previous row — handy for manual
 *      re-trigger after a position is corrected.
 *
 * Downstream consumers read snapshots directly for the progress chart. An
 * on-track to off-track transition also creates an Insight and attempts a
 * Telegram alert, with a seven-day debounce.
 */

import type { FastifyBaseLogger } from 'fastify';
import {
  prisma,
  getLatestBarsForTickers,
  queueTelegramDelivery,
  type Prisma as PrismaTypes,
} from '@vantage/db';
import {
  computeProgress,
  getUsdCadRate,
  recommendAccount,
  loadAccountSummaries,
  type GoalInput,
} from '@vantage/core';
import { shouldEmitGoalOffTrackAlert } from '../lib/goalAlerts.js';
import { easternCalendarDate } from '../lib/marketTime.js';

export interface SnapshotGoalsResult {
  goalsConsidered: number;
  snapshotsWritten: number;
  failed: number;
  offTrackAlertsEmitted: number;
}

// Minimal logger shape — matches what the existing worker jobs accept (a
// FastifyBaseLogger or Console). Re-declared locally so the export signature
// doesn't pull a Fastify type into a callsite that may use console directly.
type PinoLike = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'> | Console;

interface GoalRowForSnapshot {
  id: number;
  name: string;
  type: GoalInput['type'];
  targetAmountCad: PrismaTypes.Decimal;
  targetDate: Date | null;
  isWithdrawal: boolean;
  riskOverride: GoalInput['riskOverride'];
  accountId: number | null;
  createdAt: Date;
  offTrackAlertedAt: Date | null;
  contributions: Array<{
    allocation: PrismaTypes.Decimal;
    position: {
      id: number;
      ticker: string;
      shares: PrismaTypes.Decimal;
      avgCost: PrismaTypes.Decimal;
      currency: string;
      accountId: number;
      account: {
        id: number;
        type: string;
        currency: string;
      };
    };
  }>;
  account: { id: number; type: string; currency: string } | null;
}

function toGoalInput(row: GoalRowForSnapshot): GoalInput {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    targetAmountCad: Number(row.targetAmountCad),
    targetDate: row.targetDate,
    isWithdrawal: row.isWithdrawal,
    riskOverride: row.riskOverride,
    accountId: row.accountId,
    createdAt: row.createdAt,
  };
}

export async function snapshotGoals(log?: PinoLike): Promise<SnapshotGoalsResult> {
  const logger: PinoLike = log ?? console;
  const result: SnapshotGoalsResult = {
    goalsConsidered: 0,
    snapshotsWritten: 0,
    failed: 0,
    offTrackAlertsEmitted: 0,
  };

  const goals = (await prisma.goal.findMany({
    where: { archivedAt: null },
    include: {
      account: { select: { id: true, type: true, currency: true } },
      contributions: {
        include: {
          position: {
            include: {
              account: { select: { id: true, type: true, currency: true } },
            },
          },
        },
      },
    },
  })) as unknown as GoalRowForSnapshot[];

  result.goalsConsidered = goals.length;
  if (goals.length === 0) {
    logger.info?.({}, '[snapshotGoals] no non-archived goals — nothing to write');
    return result;
  }

  // Bulk-load latest bars for every linked ticker in one round-trip.
  const allTickers = Array.from(
    new Set(goals.flatMap((g) => g.contributions.map((c) => c.position.ticker.toUpperCase()))),
  );
  const [bars, usdToCad, accountSummaries] = await Promise.all([
    allTickers.length > 0 ? getLatestBarsForTickers(allTickers) : Promise.resolve(new Map()),
    getUsdCadRate(),
    loadAccountSummaries(),
  ]);

  const date = easternCalendarDate(new Date());

  for (const g of goals) {
    try {
      // ---- valueCad + onTrack -----------------------------------------
      const goalInput = toGoalInput(g);
      const linkedPositions = g.contributions.map((contribution) => {
        const upper = contribution.position.ticker.toUpperCase();
        const bar = bars.get(upper);
        const close = bar ? Number(bar.close) : Number(contribution.position.avgCost);
        return {
          positionId: contribution.position.id,
          ticker: upper,
          shares: Number(contribution.position.shares),
          latestClose: Number.isFinite(close) && close > 0 ? close : null,
          currency: contribution.position.currency === 'CAD' ? ('CAD' as const) : ('USD' as const),
          allocation: Number(contribution.allocation),
          accountId: contribution.position.accountId,
          accountType: contribution.position.account.type,
          goalId: g.id,
        };
      });
      const progress = computeProgress(goalInput, linkedPositions, usdToCad);
      const valueCad = progress.currentValueCad;

      // ---- roomCad -----------------------------------------------------
      //
      // Sum contributionRoomCad across non-archived accounts whose type
      // matches the goal's engine-recommended top AccountType. We don't
      // restrict to `g.account` here because the user can have multiple
      // sub-accounts of the same type (e.g. CAD-TFSA + USD-TFSA) — total
      // room available to fund the goal is the sum.
      const rec = recommendAccount(goalInput, accountSummaries);
      const topType = rec.rankedTypes[0];
      let roomCad: number | null = null;
      if (topType) {
        let any = false;
        let sum = 0;
        for (const a of accountSummaries) {
          if (a.archived) continue;
          if (a.type !== topType) continue;
          if (a.contributionRoomCad === null) continue;
          any = true;
          sum += a.contributionRoomCad;
        }
        roomCad = any ? sum : null;
      }

      // ---- upsert ------------------------------------------------------
      const previousSnapshot = await prisma.goalSnapshot.findFirst({
        where: { goalId: g.id, date: { lt: date } },
        orderBy: { date: 'desc' },
        select: { onTrack: true },
      });
      await prisma.goalSnapshot.upsert({
        where: { goalId_date: { goalId: g.id, date } },
        create: {
          goalId: g.id,
          date,
          valueCad: roundCents(valueCad),
          roomCad: roomCad === null ? null : roundCents(roomCad),
          onTrack: progress.onTrack,
        },
        update: {
          valueCad: roundCents(valueCad),
          roomCad: roomCad === null ? null : roundCents(roomCad),
          onTrack: progress.onTrack,
        },
      });
      result.snapshotsWritten += 1;

      const alertNow = new Date();
      if (
        shouldEmitGoalOffTrackAlert({
          previousOnTrack: previousSnapshot?.onTrack,
          currentOnTrack: progress.onTrack,
          lastAlertedAt: g.offTrackAlertedAt,
          now: alertNow,
        })
      ) {
        const shortfall = Math.max(progress.shortfallCad, 0);
        const baseUrl = (process.env['DASHBOARD_BASE_URL'] ?? '').replace(/\/$/, '');
        const telegramText = `Vantage goal alert\n${g.name} just moved off track.\nCurrent: C$${roundCents(valueCad).toLocaleString('en-CA')}\nShortfall: C$${roundCents(shortfall).toLocaleString('en-CA')}${baseUrl ? `\n${baseUrl}/goals/${g.id}` : ''}`;
        await prisma.$transaction(async (tx) => {
          const insight = await tx.insight.create({
            data: {
              kind: 'Alert',
              title: `${g.name} fell off track`,
              body: `Current value is C$${roundCents(valueCad).toLocaleString('en-CA')} against a C$${Number(g.targetAmountCad).toLocaleString('en-CA')} target.`,
              reasoning: `The nightly goal snapshot moved from on track to behind. Remaining shortfall: C$${roundCents(shortfall).toLocaleString('en-CA')}.`,
              citations: [],
              actionJson: { type: 'goal-review', goalId: g.id },
              confidence: 'High',
              triggeredBy: `goal-off-track:${g.id}`,
            },
          });
          await queueTelegramDelivery(
            {
              dedupeKey: `insight:${insight.id}`,
              text: telegramText,
              expiresAt: new Date(alertNow.getTime() + 7 * 24 * 60 * 60 * 1000),
            },
            tx,
          );
          await tx.goal.update({
            where: { id: g.id },
            data: { offTrackAlertedAt: alertNow },
          });
        });
        result.offTrackAlertsEmitted += 1;
        logger.info?.({ goalId: g.id }, '[snapshotGoals] goal alert queued for Telegram');
      }
    } catch (err) {
      result.failed += 1;
      logger.error?.(
        {
          goalId: g.id,
          err: err instanceof Error ? err.message : err,
        },
        '[snapshotGoals] failed to write snapshot — continuing',
      );
    }
  }

  logger.info?.(
    {
      goalsConsidered: result.goalsConsidered,
      snapshotsWritten: result.snapshotsWritten,
      failed: result.failed,
      offTrackAlertsEmitted: result.offTrackAlertsEmitted,
    },
    '[snapshotGoals] done',
  );
  return result;
}

function roundCents(v: number): number {
  return Math.round(v * 100) / 100;
}
