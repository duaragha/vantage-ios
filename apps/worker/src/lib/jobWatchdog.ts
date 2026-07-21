import { Cron } from 'croner';
import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '@vantage/db';
import { sendSelfAlert, type SendSelfAlertResult } from '@vantage/notify';
import { runJob } from './runJob.js';
import { jobLivenessSnapshot } from './jobTicks.js';

export interface WatchedSchedule {
  name: string;
  expr: string;
}

export interface ScheduleExpectation {
  name: string;
  expectedAt: Date;
  previousAt: Date;
  periodMs: number;
  allowedLatenessMs: number;
  deadlineAt: Date;
}

export interface SilentSchedule extends ScheduleExpectation {
  lastStartedAt: Date | null;
}

export interface JobWatchdogResult {
  checked: number;
  silent: Array<{
    name: string;
    expectedAt: string;
    deadlineAt: string;
    lastStartedAt: string | null;
  }>;
  alertsSent: number;
  alertsFailed: number;
}

export interface JobWatchdogHandle {
  stop: () => void;
}

const WATCHDOG_INTERVAL_MS = 30 * 60 * 1000;
const WATCHDOG_BUCKET_SECONDS = WATCHDOG_INTERVAL_MS / 1000;
const MAX_ALLOWED_LATENESS_MS = 15 * 60 * 1000;
const CLOCK_SKEW_MS = 2_000;
const MAX_ALERTED_SLOTS = 512;

/**
 * Return the newest schedule slot whose grace period has elapsed.
 *
 * For frequent jobs, the grace is half of the natural period, matching the
 * spec's 1.5x-period rule. Daily/weekly/monthly jobs cap grace at 15 minutes so
 * the 30-minute watchdog can detect a missed exact-time slot within 45 minutes.
 */
export function expectedMaturedRun(
  schedule: WatchedSchedule,
  now: Date,
  timezone: string,
): ScheduleExpectation {
  const parser = new Cron(schedule.expr, { timezone, paused: true });
  try {
    const recent = parser.previousRuns(2, now);
    const latest = recent[0];
    const previous = recent[1];
    if (!latest || !previous) {
      throw new Error(`cannot derive prior runs for ${schedule.name}`);
    }

    const recentPeriodMs = latest.getTime() - previous.getTime();
    if (!Number.isFinite(recentPeriodMs) || recentPeriodMs <= 0) {
      throw new Error(`invalid schedule period for ${schedule.name}`);
    }
    const allowedLatenessMs = Math.min(recentPeriodMs * 0.5, MAX_ALLOWED_LATENESS_MS);
    const reference = new Date(now.getTime() - allowedLatenessMs);
    const matured = parser.previousRuns(2, reference);
    const expectedAt = matured[0];
    const previousAt = matured[1];
    if (!expectedAt || !previousAt) {
      throw new Error(`cannot derive matured run for ${schedule.name}`);
    }

    return {
      name: schedule.name,
      expectedAt,
      previousAt,
      periodMs: expectedAt.getTime() - previousAt.getTime(),
      allowedLatenessMs,
      deadlineAt: new Date(expectedAt.getTime() + allowedLatenessMs),
    };
  } finally {
    parser.stop();
  }
}

export function findSilentSchedules(
  schedules: ReadonlyArray<WatchedSchedule>,
  latestStartedAt: ReadonlyMap<string, Date>,
  now: Date,
  timezone: string,
  monitoringStartedAt?: Date,
): SilentSchedule[] {
  const silent: SilentSchedule[] = [];
  for (const schedule of schedules) {
    const expected = expectedMaturedRun(schedule, now, timezone);
    // A slot that matured before this worker started was missed because the
    // service was offline, not because the live scheduler silently failed.
    if (monitoringStartedAt && expected.expectedAt.getTime() < monitoringStartedAt.getTime()) {
      continue;
    }
    const lastStartedAt = latestStartedAt.get(schedule.name) ?? null;
    if (!lastStartedAt || lastStartedAt.getTime() + CLOCK_SKEW_MS < expected.expectedAt.getTime()) {
      silent.push({ ...expected, lastStartedAt });
    }
  }
  return silent;
}

/** Newest liveness signal per job across the JobRun table and tick registry. */
export function mergeLiveness(
  fromDb: ReadonlyMap<string, Date>,
  fromTicks: ReadonlyMap<string, Date>,
): Map<string, Date> {
  const merged = new Map<string, Date>(fromDb);
  for (const [name, at] of fromTicks) {
    const prior = merged.get(name);
    if (!prior || at.getTime() > prior.getTime()) merged.set(name, at);
  }
  return merged;
}

export function watchdogAlertKey(job: Pick<ScheduleExpectation, 'name' | 'expectedAt'>): string {
  return `${job.name}:${job.expectedAt.toISOString()}`;
}

export function pendingSilentAlerts(
  silent: ReadonlyArray<SilentSchedule>,
  alertedSlots: ReadonlySet<string>,
): SilentSchedule[] {
  return silent.filter((job) => !alertedSlots.has(watchdogAlertKey(job)));
}

function rememberAlertedSlot(alertedSlots: Set<string>, job: SilentSchedule): void {
  alertedSlots.add(watchdogAlertKey(job));
  while (alertedSlots.size > MAX_ALERTED_SLOTS) {
    const oldest = alertedSlots.values().next().value;
    if (oldest === undefined) break;
    alertedSlots.delete(oldest);
  }
}

export async function runJobWatchdog(
  schedules: ReadonlyArray<WatchedSchedule>,
  log: FastifyBaseLogger | Console = console,
  opts: {
    now?: Date;
    timezone?: string;
    monitoringStartedAt?: Date;
    alertedSlots?: Set<string>;
    /** Test override for the in-process tick registry snapshot. */
    livenessSnapshot?: ReadonlyMap<string, Date>;
    sendAlert?: (
      level: 'error',
      message: string,
      context: Record<string, unknown>,
    ) => Promise<SendSelfAlertResult>;
  } = {},
): Promise<JobWatchdogResult> {
  const now = opts.now ?? new Date();
  const timezone = opts.timezone ?? process.env['TZ'] ?? 'America/Toronto';
  const names = schedules.map((schedule) => schedule.name);
  const rows = await prisma.jobRun.groupBy({
    by: ['name'],
    where: { name: { in: names } },
    _max: { startedAt: true },
  });
  const fromDb = new Map<string, Date>();
  for (const row of rows) {
    if (row._max.startedAt) fromDb.set(row.name, row._max.startedAt);
  }
  // Merge in-process liveness: a tick a precheck skipped for having no work
  // is still proof the scheduler fired and the job looked. Without this,
  // precheck'd 30s jobs would read as silent whenever their queue is empty.
  const latestStartedAt = mergeLiveness(fromDb, opts.livenessSnapshot ?? jobLivenessSnapshot());

  const silent = findSilentSchedules(
    schedules,
    latestStartedAt,
    now,
    timezone,
    opts.monitoringStartedAt,
  );
  const sendAlert = opts.sendAlert ?? sendSelfAlert;
  const alertedSlots = opts.alertedSlots ?? new Set<string>();
  const pendingAlerts = pendingSilentAlerts(silent, alertedSlots);
  let alertsSent = 0;
  let alertsFailed = 0;

  for (const job of pendingAlerts) {
    const result = await sendAlert('error', `job silent: ${job.name}`, {
      job: job.name,
      expression: schedules.find((schedule) => schedule.name === job.name)?.expr,
      timezone,
      expectedAt: job.expectedAt.toISOString(),
      deadlineAt: job.deadlineAt.toISOString(),
      lastStartedAt: job.lastStartedAt?.toISOString() ?? null,
    });
    if (result.ok) {
      alertsSent += 1;
      rememberAlertedSlot(alertedSlots, job);
    } else {
      alertsFailed += 1;
      // A debounce means this exact alert was already delivered through the
      // shared notifier, so treat the slot as handled here too.
      if (result.reason === 'debounced') rememberAlertedSlot(alertedSlots, job);
    }
  }

  if (silent.length > 0) {
    log.error?.(
      {
        silent: silent.map((job) => ({
          name: job.name,
          expectedAt: job.expectedAt.toISOString(),
          lastStartedAt: job.lastStartedAt?.toISOString() ?? null,
        })),
        alertsSent,
        alertsFailed,
      },
      'job watchdog detected silent schedules',
    );
  } else {
    log.info?.({ checked: schedules.length }, 'job watchdog: all schedules current');
  }

  return {
    checked: schedules.length,
    silent: silent.map((job) => ({
      name: job.name,
      expectedAt: job.expectedAt.toISOString(),
      deadlineAt: job.deadlineAt.toISOString(),
      lastStartedAt: job.lastStartedAt?.toISOString() ?? null,
    })),
    alertsSent,
    alertsFailed,
  };
}

/**
 * Start the watchdog on native timers so scheduler-library failure cannot also
 * disable the dead-man check. The first audit runs shortly after boot.
 */
export function startJobWatchdog(
  schedules: ReadonlyArray<WatchedSchedule>,
  log: FastifyBaseLogger | Console,
  opts: { intervalMs?: number; initialDelayMs?: number } = {},
): JobWatchdogHandle {
  const intervalMs = opts.intervalMs ?? WATCHDOG_INTERVAL_MS;
  const initialDelayMs = opts.initialDelayMs ?? 5_000;
  const monitoringStartedAt = new Date();
  const alertedSlots = new Set<string>();
  let stopped = false;
  let running = false;

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      await runJob({
        name: 'watchdog.jobs',
        bucketSeconds: WATCHDOG_BUCKET_SECONDS,
        log,
        handler: () =>
          runJobWatchdog(schedules, log, {
            monitoringStartedAt,
            alertedSlots,
          }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error?.({ err: message }, 'job watchdog execution failed');
      await sendSelfAlert('error', 'job watchdog execution failed', {
        error: message,
      });
    } finally {
      running = false;
    }
  };

  const initialTimer = setTimeout(() => void tick(), initialDelayMs);
  const intervalTimer = setInterval(() => void tick(), intervalMs);

  return {
    stop: () => {
      stopped = true;
      clearTimeout(initialTimer);
      clearInterval(intervalTimer);
    },
  };
}
