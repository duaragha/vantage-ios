import { Cron } from 'croner';

export const AUDIT_SOAK_DURATION_MS = 48 * 60 * 60 * 1_000;
export const AUDIT_SOAK_SLOT_GRACE_MS = 15 * 60 * 1_000;

const DAILY_MIN_PERIOD_MS = 20 * 60 * 60 * 1_000;
const CLOCK_SKEW_MS = 2_000;
const SCHEDULE_SAMPLE_SIZE = 8;
const MAX_SLOTS_PER_SCHEDULE = 16;

export interface AuditSoakSchedule {
  name: string;
  expr: string;
}

export interface AuditSoakRun {
  id: number;
  name: string;
  status: string;
  startedAt: Date;
  endedAt: Date | null;
  error: string | null;
}

export interface AuditSoakSlot {
  name: string;
  expectedAt: Date;
  deadlineAt: Date;
}

export interface AuditSoakSlotEvidence {
  name: string;
  expectedAt: string;
  deadlineAt: string;
  runId: number | null;
  runStatus: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

export interface AuditSoakAssessment {
  complete: boolean;
  elapsed: boolean;
  startedAt: string;
  endsAt: string;
  checkedAt: string;
  dailySchedules: string[];
  expectedSlots: number;
  succeededSlots: AuditSoakSlotEvidence[];
  pendingSlots: AuditSoakSlotEvidence[];
  missingSlots: AuditSoakSlotEvidence[];
  failedRuns: Array<{
    id: number;
    name: string;
    startedAt: string;
    endedAt: string | null;
    error: string | null;
  }>;
}

export function isDailyOrLessFrequentSchedule(
  expression: string,
  reference: Date,
  timezone: string,
): boolean {
  const parser = new Cron(expression, { timezone, paused: true });
  try {
    const runs = parser.previousRuns(SCHEDULE_SAMPLE_SIZE, reference);
    if (runs.length < 2) return false;
    for (let index = 0; index < runs.length - 1; index += 1) {
      const newer = runs[index];
      const older = runs[index + 1];
      if (!newer || !older || newer.getTime() - older.getTime() < DAILY_MIN_PERIOD_MS) {
        return false;
      }
    }
    return true;
  } finally {
    parser.stop();
  }
}

export function expectedAuditSoakSlots(
  schedules: ReadonlyArray<AuditSoakSchedule>,
  startedAt: Date,
  endsAt: Date,
  timezone: string,
): AuditSoakSlot[] {
  const reference = new Date(startedAt.getTime() - 1);
  const slots: AuditSoakSlot[] = [];

  for (const schedule of schedules) {
    if (!isDailyOrLessFrequentSchedule(schedule.expr, reference, timezone)) continue;
    const parser = new Cron(schedule.expr, { timezone, paused: true });
    try {
      const runs = parser.nextRuns(MAX_SLOTS_PER_SCHEDULE, reference);
      for (const expectedAt of runs) {
        if (expectedAt > endsAt) break;
        slots.push({
          name: schedule.name,
          expectedAt,
          deadlineAt: new Date(expectedAt.getTime() + AUDIT_SOAK_SLOT_GRACE_MS),
        });
      }
    } finally {
      parser.stop();
    }
  }

  return slots.sort(
    (left, right) =>
      left.expectedAt.getTime() - right.expectedAt.getTime() || left.name.localeCompare(right.name),
  );
}

function evidenceFor(slot: AuditSoakSlot, run: AuditSoakRun | null): AuditSoakSlotEvidence {
  return {
    name: slot.name,
    expectedAt: slot.expectedAt.toISOString(),
    deadlineAt: slot.deadlineAt.toISOString(),
    runId: run?.id ?? null,
    runStatus: run?.status ?? null,
    startedAt: run?.startedAt.toISOString() ?? null,
    endedAt: run?.endedAt?.toISOString() ?? null,
  };
}

function runForSlot(slot: AuditSoakSlot, runs: ReadonlyArray<AuditSoakRun>): AuditSoakRun | null {
  const earliest = slot.expectedAt.getTime() - CLOCK_SKEW_MS;
  const latest = slot.deadlineAt.getTime();
  return (
    runs.find(
      (run) =>
        run.name === slot.name &&
        run.startedAt.getTime() >= earliest &&
        run.startedAt.getTime() <= latest &&
        run.status === 'succeeded',
    ) ??
    runs.find(
      (run) =>
        run.name === slot.name &&
        run.startedAt.getTime() >= earliest &&
        run.startedAt.getTime() <= latest,
    ) ??
    null
  );
}

export function assessAuditSoak(input: {
  schedules: ReadonlyArray<AuditSoakSchedule>;
  runs: ReadonlyArray<AuditSoakRun>;
  startedAt: Date;
  now: Date;
  timezone?: string;
}): AuditSoakAssessment {
  const timezone = input.timezone ?? 'America/Toronto';
  const endsAt = new Date(input.startedAt.getTime() + AUDIT_SOAK_DURATION_MS);
  const dailySchedules = input.schedules
    .filter((schedule) => isDailyOrLessFrequentSchedule(schedule.expr, input.startedAt, timezone))
    .map((schedule) => schedule.name);
  const slots = expectedAuditSoakSlots(input.schedules, input.startedAt, endsAt, timezone);
  const succeededSlots: AuditSoakSlotEvidence[] = [];
  const pendingSlots: AuditSoakSlotEvidence[] = [];
  const missingSlots: AuditSoakSlotEvidence[] = [];

  for (const slot of slots) {
    const run = runForSlot(slot, input.runs);
    const evidence = evidenceFor(slot, run);
    if (run?.status === 'succeeded') {
      succeededSlots.push(evidence);
    } else if (run || input.now < slot.deadlineAt) {
      pendingSlots.push(evidence);
    } else {
      missingSlots.push(evidence);
    }
  }

  const failedRuns = input.runs
    .filter((run) => run.status === 'failed')
    .map((run) => ({
      id: run.id,
      name: run.name,
      startedAt: run.startedAt.toISOString(),
      endedAt: run.endedAt?.toISOString() ?? null,
      error: run.error,
    }));
  const elapsed = input.now >= endsAt;
  const complete =
    elapsed && pendingSlots.length === 0 && missingSlots.length === 0 && failedRuns.length === 0;

  return {
    complete,
    elapsed,
    startedAt: input.startedAt.toISOString(),
    endsAt: endsAt.toISOString(),
    checkedAt: input.now.toISOString(),
    dailySchedules,
    expectedSlots: slots.length,
    succeededSlots,
    pendingSlots,
    missingSlots,
    failedRuns,
  };
}
