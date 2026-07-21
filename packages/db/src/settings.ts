/**
 * UserSettings CRUD helpers. Single-row table keyed on id=1.
 */

import type { Prisma, UserSettings } from '@prisma/client';
import { prisma } from './client.js';

export function getSettings(): Promise<UserSettings | null> {
  return prisma.userSettings.findUnique({ where: { id: 1 } });
}

export function updateSettings(
  data: Prisma.UserSettingsUpdateInput,
): Promise<UserSettings> {
  return prisma.userSettings.update({ where: { id: 1 }, data });
}
