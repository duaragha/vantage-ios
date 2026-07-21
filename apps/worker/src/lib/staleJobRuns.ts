import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '@vantage/db';

export function isOwnedByPreviousWorker(startedAt: Date, workerStartedAt: Date): boolean {
  return startedAt.getTime() < workerStartedAt.getTime();
}

/**
 * Close rows left running by the replaced worker before new schedules start.
 * Vantage runs one worker replica, so every pre-start `running` row is orphaned.
 */
export async function closeStaleJobRuns(
  log: FastifyBaseLogger | Console = console,
  workerStartedAt = new Date(),
): Promise<number> {
  const result = await prisma.jobRun.updateMany({
    where: {
      status: 'running',
      startedAt: { lt: workerStartedAt },
    },
    data: {
      status: 'failed',
      endedAt: workerStartedAt,
      error: 'abandoned: worker exited before completion',
    },
  });
  if (result.count > 0) {
    log.warn?.(
      { count: result.count, workerStartedAt: workerStartedAt.toISOString() },
      'closed JobRun rows abandoned by the previous worker',
    );
  }
  return result.count;
}
