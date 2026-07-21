/**
 * In-process job tick registry.
 *
 * runJob() records every scheduler tick here, including ticks that were
 * skipped by a precheck because the job had no work. The watchdog and the
 * deep-health probe merge these timestamps with the JobRun table so an
 * idle-skipped tick still counts as "the scheduler fired and the job looked"
 * — without paying a JobRun insert/update per empty tick.
 *
 * The registry is process-local by design: the watchdog and health routes run
 * in the same worker process as the scheduler, and both already treat slots
 * that matured before process start as out of scope (monitoringStartedAt).
 */

const lastTick = new Map<string, Date>();
const lastIdleSkip = new Map<string, Date>();
const lastRealRun = new Map<string, Date>();

/** Record that the scheduler invoked this job (before any precheck). */
export function recordJobTick(name: string, at: Date = new Date()): void {
  lastTick.set(name, at);
}

/** Record that this tick was skipped because the precheck found no work. */
export function recordIdleSkip(name: string, at: Date = new Date()): void {
  lastIdleSkip.set(name, at);
}

/** Record that a real run started (a JobRun row was created). */
export function recordRealRun(name: string, at: Date = new Date()): void {
  lastRealRun.set(name, at);
}

export function lastJobTickAt(name: string): Date | null {
  return lastTick.get(name) ?? null;
}

export function lastIdleSkipAt(name: string): Date | null {
  return lastIdleSkip.get(name) ?? null;
}

export function lastRealRunAt(name: string): Date | null {
  return lastRealRun.get(name) ?? null;
}

/** Snapshot of the newest liveness signal (tick or idle skip) per job. */
export function jobLivenessSnapshot(): ReadonlyMap<string, Date> {
  const merged = new Map<string, Date>();
  for (const [name, at] of lastTick) merged.set(name, at);
  for (const [name, at] of lastIdleSkip) {
    const prior = merged.get(name);
    if (!prior || at.getTime() > prior.getTime()) merged.set(name, at);
  }
  return merged;
}

/** Test hook — clear all registry state. */
export function __resetJobTicks(): void {
  lastTick.clear();
  lastIdleSkip.clear();
  lastRealRun.clear();
}
