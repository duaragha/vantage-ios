import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Logger as PinoLogger } from 'pino';
import { getLogger } from '@vantage/notify';
import { jobsRoutes } from './routes/jobs.js';
import { healthRoutes } from './routes/health.js';
import { metricsRoutes } from './routes/metrics.js';

export type WorkerServer = FastifyInstance<
  Server,
  IncomingMessage,
  ServerResponse,
  PinoLogger
>;

export function buildServer(): WorkerServer {
  // Hand Fastify our shared pino instance so request logs land in the same
  // stream (and pass through the same redaction rules) as app-level logs.
  const server = Fastify<Server, IncomingMessage, ServerResponse, PinoLogger>({
    loggerInstance: getLogger(),
  });

  // Unauthenticated liveness probe. Registered BEFORE jobsRoutes so it
  // doesn't inherit the worker-secret preHandler.
  server.register(healthRoutes);

  server.register(metricsRoutes);
  server.register(jobsRoutes);

  return server;
}
