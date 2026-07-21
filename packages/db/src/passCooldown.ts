/**
 * PassCooldown CRUD helpers.
 *
 * Each row enforces the "don't re-suggest this action for this ticker until <date>"
 * contract. Uniqueness is on (ticker, actionKind), so we always upsert by that pair.
 */

import type { PassCooldown } from '@prisma/client';
import { prisma } from './client.js';

export type CooldownActionKind = 'buy' | 'trim' | 'rotate';

export interface SetCooldownInput {
  ticker: string;
  actionKind: CooldownActionKind;
  until: Date;
  insightId?: number | null;
}

export function setPassCooldown(input: SetCooldownInput): Promise<PassCooldown> {
  const { ticker, actionKind, until, insightId } = input;
  return prisma.passCooldown.upsert({
    where: { ticker_actionKind: { ticker, actionKind } },
    create: { ticker, actionKind, until, insightId: insightId ?? null },
    update: { until, insightId: insightId ?? null },
  });
}

export async function isPassCooldownActive(
  ticker: string,
  actionKind: CooldownActionKind,
  now: Date = new Date(),
): Promise<boolean> {
  const row = await prisma.passCooldown.findUnique({
    where: { ticker_actionKind: { ticker, actionKind } },
  });
  if (!row) return false;
  return row.until > now;
}

export async function purgeExpiredPassCooldowns(
  now: Date = new Date(),
): Promise<number> {
  const result = await prisma.passCooldown.deleteMany({
    where: { until: { lte: now } },
  });
  return result.count;
}
