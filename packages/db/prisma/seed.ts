/**
 * Seed script — populates UserSettings row id=1 with defaults + bcrypted admin password.
 *
 * Usage:
 *   ADMIN_PASSWORD=<plaintext> pnpm --filter @vantage/db prisma db seed
 */

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const plaintext = process.env['ADMIN_PASSWORD'];
  if (!plaintext || plaintext.length < 4) {
    console.error('ERROR: set ADMIN_PASSWORD env var (min 4 chars) before running the seed.');
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(plaintext, 12);

  const settings = await prisma.userSettings.upsert({
    where: { id: 1 },
    update: {
      passwordHash,
    },
    create: {
      id: 1,
      passwordHash,
      monthlyBudget: 0,
      singlePositionCapPct: 15,
      sectorCapPct: 40,
      intradayMoveThresholdPct: 5,
      passCooldownDays: 14,
      perTickerDailyAlertCap: 3,
      dailySpendCapUsd: 2.0,
      monthlySpendCapUsd: 10.0,
      killSwitch: false,
      timezone: 'America/Toronto',
    },
  });

  console.log(
    `Seeded UserSettings id=${settings.id} (timezone=${settings.timezone}, killSwitch=${String(
      settings.killSwitch,
    )})`,
  );
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
