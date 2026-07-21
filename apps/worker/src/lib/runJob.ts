/**
 * Shared job runner.
 *
 * Wraps a handler with:
 *   1. Single-flight execution per job name. If a running JobRun exists, we
 *      skip so a slow poll cannot overlap its next slot. Startup recovery
 *      closes rows abandoned by a previous worker process.
 *   2. JobRun row lifecycle — inserts running, updates to succeeded/failed
 *      with the handler's result merged into `metadata`.
 *   3. Error capture — uncaught throws land as `failed` with the stack in
 *      `error`, never bubble up (so cron-scheduled calls don't crash the
 *      process).
 *
 * dateBucket is computed by rounding `now` down to the job's natural period
 * (30s / 1min / 5min / 15min / 1h / 1d). Callers pass the period in seconds; we
 * floor to that boundary so two invocations inside the same bucket share a
 * key.
 */

import type { FastifyBaseLogger } from 'fastify';
import { randomUUID } from 'node:crypto';
import { prisma, type JobRun, type Prisma } from '@vantage/db';
import { sendSelfAlert, type SendSelfAlertResult } from '@vantage/notify';
import { jobSingleFlight } from './localSingleFlight.js';
import { lastRealRunAt, recordIdleSkip, recordJobTick, recordRealRun } from './jobTicks.js';

const RUNNER_INSTANCE_ID = randomUUID();

/**
 * Even a permanently-idle precheck'd job runs for real at least this often,
 * so the JobRun table keeps a truthful heartbeat row and a precheck bug can
 * delay work by at most this window.
 */
export const PRECHECK_HEARTBEAT_MS = 15 * 60 * 1000;

export interface RunJobOptions<T> {
  /** Unique job name, e.g. "poll.news". Becomes JobRun.name. */
  name: string;
  /** Period in seconds for the idempotency bucket. 5min polls => 300. */
  bucketSeconds: number;
  /** Optional structured logger. */
  log?: FastifyBaseLogger | Console;
  /** The actual job body. Return a JSON-serializable summary for metadata. */
  handler: () => Promise<T>;
  /**
   * Optional cheap gate evaluated before the JobRun row is touched. Return
   * false to skip this tick entirely (no row, no handler). Must only return
   * false when there is provably no work; a throw fails open into a real run.
   * Unless disabled via heartbeatMs, a real run is forced once per
   * PRECHECK_HEARTBEAT_MS so observers outside this process still see life.
   */
  precheck?: () => Promise<boolean>;
  /**
   * Heartbeat window override. Defaults to PRECHECK_HEARTBEAT_MS. Pass 0 to
   * disable the forced run — correct for cadence gates (they fire by clock
   * construction, so a heartbeat would defeat their off-peak thinning), wrong
   * for work-queue gates (an always-empty queue would otherwise never write a
   * truthful JobRun row again).
   */
  heartbeatMs?: number;
}

export interface RunJobResult<T> {
  /** true if the job actually ran, false if skipped (duplicate in-flight). */
  ran: boolean;
  /** JobRun row id (present when ran=true or a conflicting row was found). */
  jobRunId: number | null;
  /** Handler return value (only on successful run). */
  result: T | null;
  /** Error message if the handler threw. */
  error: string | null;
}

export async function sendJobFailureAlert(
  name: string,
  bucket: string,
  error: string,
  sender: typeof sendSelfAlert = sendSelfAlert,
): Promise<SendSelfAlertResult> {
  return sender('error', `Job failed: ${name}`, {
    job: name,
    bucket,
    error,
  });
}

/**
 * Floor a Date to the nearest bucketSeconds boundary (UTC), return ISO string.
 * The ISO string lands in JobRun.metadata.bucket so operators can see which
 * bucket a run belonged to.
 */
export function bucketKey(now: Date, bucketSeconds: number): string {
  if (bucketSeconds <= 0 || !Number.isFinite(bucketSeconds)) {
    throw new Error('bucketSeconds must be > 0');
  }
  const ms = bucketSeconds * 1000;
  const floored = Math.floor(now.getTime() / ms) * ms;
  return new Date(floored).toISOString();
}

/**
 * Check if any JobRun with the same name is still running. This is
 * deliberately independent of the bucket: a one-minute job that takes 70
 * seconds must not start a second copy in the following minute.
 */
async function findInFlight(name: string): Promise<JobRun | null> {
  return prisma.jobRun.findFirst({
    where: {
      name,
      status: 'running',
    },
    orderBy: { startedAt: 'desc' },
  });
}

async function findCompletedInBucket(name: string, bucket: string): Promise<JobRun | null> {
  return prisma.jobRun.findFirst({
    where: {
      name,
      status: 'succeeded',
      metadata: {
        path: ['bucket'],
        equals: bucket,
      },
    },
    orderBy: { endedAt: 'desc' },
  });
}

export function runnerInstanceIdFromMetadata(metadata: Prisma.JsonValue | null): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>)['runnerInstanceId'];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export async function runJob<T>(opts: RunJobOptions<T>): Promise<RunJobResult<T>> {
  const { name, bucketSeconds, log } = opts;
  const now = new Date();
  const bucket = bucketKey(now, bucketSeconds);
  recordJobTick(name, now);

  if (!jobSingleFlight.claim(name)) {
    (log ?? console).info?.({ job: name, bucket }, 'runJob skipped: locally in-flight');
    return { ran: false, jobRunId: null, result: null, error: null };
  }

  try {
    if (opts.precheck && !heartbeatDue(name, now, opts.heartbeatMs ?? PRECHECK_HEARTBEAT_MS)) {
      let hasWork = true;
      try {
        hasWork = await opts.precheck();
      } catch (err) {
        (log ?? console).warn?.(
          { job: name, bucket, err: err instanceof Error ? err.message : err },
          'runJob precheck threw — failing open into a real run',
        );
      }
      if (!hasWork) {
        recordIdleSkip(name, now);
        (log ?? console).debug?.({ job: name, bucket }, 'runJob skipped: precheck found no work');
        return { ran: false, jobRunId: null, result: null, error: null };
      }
    }
    return await runClaimedJob(opts, bucket);
  } finally {
    jobSingleFlight.release(name);
  }
}

/**
 * True when this job has not started a real run within the heartbeat window
 * in this process lifetime. A fresh process always heartbeats first so the
 * database reflects reality after a restart. A window of 0 disables the
 * heartbeat entirely.
 */
function heartbeatDue(name: string, now: Date, windowMs: number): boolean {
  if (windowMs <= 0) return false;
  const last = lastRealRunAt(name);
  return !last || now.getTime() - last.getTime() >= windowMs;
}

async function runClaimedJob<T>(opts: RunJobOptions<T>, bucket: string): Promise<RunJobResult<T>> {
  const { name, handler, log } = opts;

  // Cross-restart and cross-process idempotency guard.
  const [foundInFlight, completed] = await Promise.all([
    findInFlight(name),
    findCompletedInBucket(name, bucket),
  ]);
  let inFlight = foundInFlight;
  if (inFlight && runnerInstanceIdFromMetadata(inFlight.metadata) === RUNNER_INSTANCE_ID) {
    await prisma.jobRun.update({
      where: { id: inFlight.id },
      data: {
        status: 'failed',
        endedAt: new Date(),
        error: 'abandoned: prior run finalization failed in this worker',
      },
    });
    (log ?? console).warn?.(
      { job: name, bucket, abandonedId: inFlight.id },
      'closed an abandoned same-worker JobRun',
    );
    inFlight = null;
  }
  if (inFlight) {
    (log ?? console).info?.(
      { job: name, bucket, existingId: inFlight.id },
      'runJob skipped — duplicate in-flight',
    );
    return { ran: false, jobRunId: inFlight.id, result: null, error: null };
  }
  if (completed) {
    (log ?? console).info?.(
      { job: name, bucket, existingId: completed.id },
      'runJob skipped: bucket already succeeded',
    );
    return { ran: false, jobRunId: completed.id, result: null, error: null };
  }

  const startMeta: Prisma.InputJsonValue = {
    bucket,
    runnerInstanceId: RUNNER_INSTANCE_ID,
  };
  const jobRun = await prisma.jobRun.create({
    data: {
      name,
      status: 'running',
      metadata: startMeta,
    },
  });
  recordRealRun(name, jobRun.startedAt);
  (log ?? console).info?.({ job: name, bucket, id: jobRun.id }, 'job started');

  try {
    const result = await handler();
    const summary = toJsonValue(result);
    const endMeta: Prisma.InputJsonValue = {
      bucket,
      summary,
    };
    await prisma.jobRun.update({
      where: { id: jobRun.id },
      data: {
        status: 'succeeded',
        endedAt: new Date(),
        metadata: endMeta,
      },
    });
    (log ?? console).info?.({ job: name, bucket, id: jobRun.id, summary }, 'job succeeded');
    return { ran: true, jobRunId: jobRun.id, result, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    const endMeta: Prisma.InputJsonValue = {
      bucket,
      stack: stack ?? null,
    };
    try {
      await prisma.jobRun.update({
        where: { id: jobRun.id },
        data: {
          status: 'failed',
          endedAt: new Date(),
          error: message,
          metadata: endMeta,
        },
      });
    } catch (finalizeErr) {
      (log ?? console).error?.(
        {
          job: name,
          bucket,
          id: jobRun.id,
          err: finalizeErr instanceof Error ? finalizeErr.message : String(finalizeErr),
        },
        'failed to finalize JobRun; next tick will recover it',
      );
    }
    (log ?? console).error?.({ job: name, bucket, id: jobRun.id, err: message }, 'job failed');

    // Every failed JobRun is operationally actionable. Adapter-specific alerts
    // can add detail, while sendSelfAlert's debounce prevents retry storms.
    try {
      await sendJobFailureAlert(name, bucket, message);
    } catch (alertErr) {
      (log ?? console).error?.(
        {
          job: name,
          bucket,
          err: alertErr instanceof Error ? alertErr.message : String(alertErr),
        },
        'job failure alert could not be sent',
      );
    }

    return { ran: true, jobRunId: jobRun.id, result: null, error: message };
  }
}

/** Best-effort deep JSON serialization guard. */
function toJsonValue(v: unknown): Prisma.InputJsonValue {
  if (v === null || v === undefined) return {};
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return v;
  }
  try {
    return JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
  } catch {
    return { note: 'non-serializable handler result' };
  }
}
