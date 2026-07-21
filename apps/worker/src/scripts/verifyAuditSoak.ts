import { prisma } from '@vantage/db';
import { CRON_SPECS } from '../cron.js';
import { assessAuditSoak } from '../lib/auditSoak.js';

function parseDate(value: string | undefined, label: string): Date {
  if (!value) throw new Error(`${label} is required`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} must be an ISO timestamp`);
  return date;
}

const startedAt = parseDate(
  process.argv[2] ?? process.env['AUDIT_SOAK_STARTED_AT'],
  'soak start timestamp',
);
const now = process.argv[3] ? parseDate(process.argv[3], 'check timestamp') : new Date();
const timezone = process.env['TZ'] ?? 'America/Toronto';

try {
  const runs = await prisma.jobRun.findMany({
    where: {
      startedAt: { gte: startedAt, lte: now },
      name: { in: CRON_SPECS.map((schedule) => schedule.name) },
    },
    orderBy: { startedAt: 'asc' },
    select: {
      id: true,
      name: true,
      status: true,
      startedAt: true,
      endedAt: true,
      error: true,
    },
  });
  const assessment = assessAuditSoak({
    schedules: CRON_SPECS,
    runs,
    startedAt,
    now,
    timezone,
  });
  console.log(JSON.stringify(assessment, null, 2));
  if (!assessment.complete) process.exitCode = 2;
} finally {
  await prisma.$disconnect();
}
