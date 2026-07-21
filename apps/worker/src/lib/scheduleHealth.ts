import { Cron } from 'croner';

export type ScheduleHealthStatus = 'fresh' | 'running' | 'stale' | 'error' | 'unknown';

const CLOCK_SKEW_MS = 2_000;
export const MAX_HEALTHY_RUNNING_MS = 60 * 60 * 1_000;

/**
 * Compare a successful run with the two latest expected slots. The latest
 * slot is fresh, one missed slot is stale, and two or more missed slots are an
 * error. Cron parsing naturally respects nights, weekends, holidays encoded in
 * the expression, and daylight-saving changes in the configured timezone.
 */
export function scheduleHealthStatus(
  expression: string,
  lastSuccessAt: Date | null,
  now: Date,
  timezone = 'America/Toronto',
  latestRunningAt: Date | null = null,
): ScheduleHealthStatus {
  if (latestRunningAt && (!lastSuccessAt || latestRunningAt > lastSuccessAt)) {
    const runningAgeMs = now.getTime() - latestRunningAt.getTime();
    if (runningAgeMs <= MAX_HEALTHY_RUNNING_MS) return 'running';
    return 'error';
  }
  if (!lastSuccessAt) return 'unknown';
  const parser = new Cron(expression, { timezone, paused: true });
  try {
    const runs = parser.previousRuns(2, now);
    const latest = runs[0];
    const previous = runs[1];
    if (!latest || !previous) return 'unknown';
    const completedAt = lastSuccessAt.getTime() + CLOCK_SKEW_MS;
    if (completedAt >= latest.getTime()) return 'fresh';
    if (completedAt >= previous.getTime()) return 'stale';
    return 'error';
  } finally {
    parser.stop();
  }
}

export function scheduledJobsHealthy(statuses: readonly ScheduleHealthStatus[]): boolean {
  return !statuses.includes('error');
}
