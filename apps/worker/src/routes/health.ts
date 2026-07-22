/**
 * Health probes.
 *
 *   GET /health       — unauthenticated liveness. No DB hit. Safe for public
 *                       monitoring (Tailscale to gaming PC, Docker health,
 *                       and uptime probes).
 *   GET /health/deep  — auth required. Aggregates the signals that matter for
 *                       "is the agent actually working": DB reachability, last
 *                       successful run per poll job, today's LLM spend, kill
 *                       switch status, source-adapter health summary.
 *
 * The deep probe is intentionally cheap (<~100ms typical): a few indexed
 * queries and nothing that touches external APIs.
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import {
  AppNotificationDeliveryStatus,
  prisma,
  startOfZonedDay,
  TelegramDeliveryStatus,
} from '@vantage/db';
import { CRON_SPECS } from '../cron.js';
import { requireWorkerSecret } from '../lib/auth.js';
import { lastIdleSkipAt } from '../lib/jobTicks.js';
import { scheduledJobsHealthy, scheduleHealthStatus } from '../lib/scheduleHealth.js';

export const healthRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.get('/health', async () => ({
    ok: true,
    service: 'vantage-worker',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  }));

  fastify.get('/health/deep', { preHandler: requireWorkerSecret }, async (_req, reply) => {
    const now = new Date();

    // DB reachability — a trivial select to distinguish "cannot reach
    // Postgres" from "Postgres returned 0 rows."
    let dbOk = true;
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch (err) {
      dbOk = false;
      fastify.log.error({ err }, 'deep health database probe failed');
    }

    if (!dbOk) {
      return reply.code(503).send({
        ok: false,
        db: { ok: false, error: 'database unavailable' },
        uptime: process.uptime(),
        timestamp: now.toISOString(),
      });
    }

    // Settings drive both spend-cap semantics and the calendar boundary shown
    // here. Resolve them before aggregating so health matches the LLM wrapper.
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

    // One grouped query covers every registered schedule. Freshness is based
    // on expected cron slots, not a universal wall-clock age.
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
    const lastRunsEntries = CRON_SPECS.map((spec) => {
      const endedAt = successByName.get(spec.name) ?? null;
      const runningAt = runningByName.get(spec.name) ?? null;
      // A precheck'd tick that found no work is a healthy outcome, not a
      // missed slot. Merge the in-process idle-skip time so freshness math
      // doesn't demand a JobRun row per empty tick. Reported separately so
      // the payload stays honest about what actually ran.
      const idleSkipAt = lastIdleSkipAt(spec.name);
      const effectiveSuccessAt =
        idleSkipAt && (!endedAt || idleSkipAt.getTime() > endedAt.getTime()) ? idleSkipAt : endedAt;
      const ageMs = endedAt ? now.getTime() - endedAt.getTime() : null;
      const runningAgeMs = runningAt ? now.getTime() - runningAt.getTime() : null;
      return [
        spec.name,
        {
          expression: spec.expr,
          lastSuccessAt: endedAt ? endedAt.toISOString() : null,
          lastIdleSkipAt: idleSkipAt ? idleSkipAt.toISOString() : null,
          ageSeconds: ageMs === null ? null : Math.max(0, Math.floor(ageMs / 1000)),
          runningSince: runningAt ? runningAt.toISOString() : null,
          runningAgeSeconds:
            runningAgeMs === null ? null : Math.max(0, Math.floor(runningAgeMs / 1000)),
          status: scheduleHealthStatus(spec.expr, effectiveSuccessAt, now, timezone, runningAt),
        },
      ] as const;
    });
    const lastRuns = Object.fromEntries(lastRunsEntries);
    const jobsHealthy = scheduledJobsHealthy(lastRunsEntries.map(([, value]) => value.status));

    // Today's LLM cost.
    const todayAgg = await prisma.llmCall.aggregate({
      _sum: { costUsd: true },
      where: { createdAt: { gte: startOfDay } },
    });
    const llmCostToday = Number(todayAgg._sum.costUsd ?? 0);

    const [
      telegramPending,
      telegramDead,
      oldestTelegramPending,
      appPushPending,
      appPushDead,
      oldestAppPushPending,
      appPushSubscriptions,
    ] = await Promise.all([
      prisma.telegramDelivery.count({
        where: { status: TelegramDeliveryStatus.Pending },
      }),
      prisma.telegramDelivery.count({
        where: { status: TelegramDeliveryStatus.Dead },
      }),
      prisma.telegramDelivery.findFirst({
        where: { status: TelegramDeliveryStatus.Pending },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
      prisma.appNotificationDelivery.count({
        where: { status: AppNotificationDeliveryStatus.Pending },
      }),
      prisma.appNotificationDelivery.count({
        where: { status: AppNotificationDeliveryStatus.Dead },
      }),
      prisma.appNotificationDelivery.findFirst({
        where: { status: AppNotificationDeliveryStatus.Pending },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
      prisma.webPushSubscription.count({ where: { disabledAt: null } }),
    ]);
    const telegramConfigured = Boolean(
      process.env['TELEGRAM_BOT_TOKEN'] && process.env['TELEGRAM_CHAT_ID'],
    );
    const appPushConfigured = Boolean(
      process.env['WEB_PUSH_PUBLIC_KEY'] && process.env['WEB_PUSH_PRIVATE_KEY'],
    );

    return reply.code(jobsHealthy ? 200 : 503).send({
      ok: jobsHealthy,
      service: 'vantage-worker',
      timestamp: now.toISOString(),
      uptime: process.uptime(),
      db: { ok: true },
      killSwitch: settings?.killSwitch ?? null,
      spend: {
        todayUsd: Number(llmCostToday.toFixed(4)),
        dailyCapUsd: settings ? Number(settings.dailySpendCapUsd) : null,
        monthlyCapUsd: settings ? Number(settings.monthlySpendCapUsd) : null,
      },
      telegram: {
        ok: telegramConfigured && telegramDead === 0,
        configured: telegramConfigured,
        pending: telegramPending,
        dead: telegramDead,
        oldestPendingAt: oldestTelegramPending?.createdAt.toISOString() ?? null,
      },
      appNotifications: {
        ok: appPushConfigured && appPushSubscriptions > 0 && appPushDead === 0,
        configured: appPushConfigured,
        subscriptions: appPushSubscriptions,
        pending: appPushPending,
        dead: appPushDead,
        oldestPendingAt: oldestAppPushPending?.createdAt.toISOString() ?? null,
      },
      lastRuns,
    });
  });
};
