/**
 * /metrics/snapshot — aggregate observability payload.
 *
 * Surfaces the same shape the /ops web page already computes so the dashboard
 * (or a CLI curl) can consume a single endpoint instead of re-doing the
 * aggregations inline. Auth required; avoid exposing spend + job history
 * publicly.
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { prisma, startOfZonedDay, startOfZonedMonth } from '@vantage/db';
import { requireWorkerSecret } from '../lib/auth.js';
import { CRON_SPECS } from '../cron.js';
import { scheduleHealthStatus } from '../lib/scheduleHealth.js';

export const metricsRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.get('/metrics/snapshot', { preHandler: requireWorkerSecret }, async () => {
    const now = new Date();
    const settings = await prisma.userSettings.findUnique({
      where: { id: 1 },
      select: {
        timezone: true,
        killSwitch: true,
        dailySpendCapUsd: true,
        monthlySpendCapUsd: true,
      },
    });
    const timezone = settings?.timezone ?? process.env['TZ'] ?? 'America/Toronto';
    const startOfDay = startOfZonedDay(now, timezone);
    const startOfMonth = startOfZonedMonth(now, timezone);

    const [todayAgg, monthAgg, cacheAgg, recentJobs, recentErrors, telegramByStatus] =
      await Promise.all([
        prisma.llmCall.aggregate({
          _sum: { costUsd: true },
          where: { createdAt: { gte: startOfDay } },
        }),
        prisma.llmCall.aggregate({
          _sum: { costUsd: true },
          where: { createdAt: { gte: startOfMonth } },
        }),
        prisma.llmCall.aggregate({
          _sum: { cachedTokens: true, inputTokens: true },
          where: { createdAt: { gte: startOfMonth } },
        }),
        prisma.jobRun.findMany({
          orderBy: { startedAt: 'desc' },
          take: 50,
          select: {
            id: true,
            name: true,
            status: true,
            startedAt: true,
            endedAt: true,
            error: true,
          },
        }),
        prisma.jobRun.findMany({
          where: { status: 'failed' },
          orderBy: { startedAt: 'desc' },
          take: 20,
          select: {
            id: true,
            name: true,
            startedAt: true,
            endedAt: true,
            error: true,
          },
        }),
        prisma.telegramDelivery.groupBy({
          by: ['status'],
          _count: { _all: true },
        }),
      ]);

    const scheduleNames = CRON_SPECS.map((spec) => spec.name);
    const [successfulRuns, runningRuns] = await Promise.all([
      prisma.jobRun.groupBy({
        by: ['name'],
        where: { name: { in: scheduleNames }, status: 'succeeded' },
        _max: { endedAt: true },
      }),
      prisma.jobRun.groupBy({
        by: ['name'],
        where: { name: { in: scheduleNames }, status: 'running' },
        _max: { startedAt: true },
      }),
    ]);
    const successByName = new Map(
      successfulRuns.map((row) => [row.name, row._max.endedAt ?? null]),
    );
    const runningByName = new Map(runningRuns.map((row) => [row.name, row._max.startedAt ?? null]));
    const sourceHealth = CRON_SPECS.map((spec) => {
      const lastSuccessAt = successByName.get(spec.name) ?? null;
      const runningAt = runningByName.get(spec.name) ?? null;
      return {
        name: spec.name,
        expression: spec.expr,
        lastSuccessAt: lastSuccessAt ? lastSuccessAt.toISOString() : null,
        runningSince: runningAt ? runningAt.toISOString() : null,
        status: scheduleHealthStatus(spec.expr, lastSuccessAt, now, timezone, runningAt),
      };
    });

    const llmToday = Number(todayAgg._sum.costUsd ?? 0);
    const llmMonth = Number(monthAgg._sum.costUsd ?? 0);
    const cachedTokens = Number(cacheAgg._sum.cachedTokens ?? 0);
    const inputTokens = Number(cacheAgg._sum.inputTokens ?? 0);
    const cacheHitRatePct = inputTokens > 0 ? (cachedTokens / inputTokens) * 100 : 0;

    return {
      timestamp: now.toISOString(),
      spend: {
        todayUsd: Number(llmToday.toFixed(4)),
        monthUsd: Number(llmMonth.toFixed(4)),
        dailyCapUsd: settings ? Number(settings.dailySpendCapUsd) : null,
        monthlyCapUsd: settings ? Number(settings.monthlySpendCapUsd) : null,
      },
      cache: {
        hitRatePct: Number(cacheHitRatePct.toFixed(2)),
        cachedTokens,
        inputTokens,
      },
      killSwitch: settings?.killSwitch ?? null,
      telegram: {
        configured: Boolean(process.env['TELEGRAM_BOT_TOKEN'] && process.env['TELEGRAM_CHAT_ID']),
        byStatus: Object.fromEntries(telegramByStatus.map((row) => [row.status, row._count._all])),
      },
      sourceHealth,
      recentJobs: recentJobs.map((j) => ({
        ...j,
        startedAt: j.startedAt.toISOString(),
        endedAt: j.endedAt ? j.endedAt.toISOString() : null,
      })),
      recentErrors: recentErrors.map((e) => ({
        ...e,
        startedAt: e.startedAt.toISOString(),
        endedAt: e.endedAt ? e.endedAt.toISOString() : null,
      })),
    };
  });
};
