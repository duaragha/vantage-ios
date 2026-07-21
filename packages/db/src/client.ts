/**
 * Prisma client singleton.
 *
 * The singleton guard prevents the "too many Prisma clients" warning during
 * Next.js hot-reload in dev — it reuses one client across module reloads.
 */

import { PrismaClient } from '@prisma/client';

declare global {
  var __equityAgentPrisma: PrismaClient | undefined;
}

function createClient(): PrismaClient {
  return new PrismaClient({ log: ['warn', 'error'] });
}

export const prisma: PrismaClient = globalThis.__equityAgentPrisma ?? createClient();

if (process.env['NODE_ENV'] !== 'production') {
  globalThis.__equityAgentPrisma = prisma;
}

export type DbClient = typeof prisma;
