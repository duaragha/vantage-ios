/**
 * Shared pino logger factory.
 *
 * Lives in @vantage/notify (not core) so that @vantage/llm — which
 * needs to log kill-switch and spend-cap events — can consume it without
 * creating a dep cycle. @vantage/core re-exports this module so callers
 * can `import { logger } from '@vantage/core'` per the spec.
 *
 * Responsibilities:
 *   - Build a pino instance tuned for the current env:
 *       * NODE_ENV !== 'production' → pino-pretty transport (colorized, short ts)
 *       * production → JSON on stdout
 *   - Level from LOG_LEVEL env var, default 'info'
 *   - Base context: service name (auto-detected from SERVICE_NAME / binary path
 *     fallback), pid, hostname
 *   - Redaction paths cover the full list of sensitive secret keys used in this
 *     repo (API keys, bot tokens, passwords, auth headers)
 *   - `child(bindings)` for component-scoped child loggers
 *   - `logInfo`, `logError`, `logWarn` helpers that auto-serialize Error objects
 *     (stack + cause chain) so callers don't have to think about it
 */

import { hostname as osHostname } from 'node:os';
import pino, { type Logger, type LoggerOptions } from 'pino';

// ---------------------------------------------------------------------------
// Redaction paths
// ---------------------------------------------------------------------------

/**
 * Every env var / header / object key that might carry a secret. Pino accepts
 * dotted paths + bracket wildcards; the `[*]` wildcard covers arrays of objects
 * (e.g. an array of error contexts each carrying an `authorization` field).
 */
const REDACT_PATHS: readonly string[] = [
  // Anthropic + data provider keys
  'ANTHROPIC_API_KEY',
  'FINNHUB_API_KEY',
  'TIINGO_API_KEY',
  'FRED_API_KEY',
  'ALPACA_SECRET_KEY',
  'ALPACA_KEY_ID',
  'TAVILY_API_KEY',
  'CODEMAGIC_API_TOKEN',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'WORKER_SECRET',
  'ADMIN_PASSWORD_HASH',
  'ADMIN_PASSWORD_HASH_B64',
  'ADMIN_PASSWORD',
  'SESSION_SECRET',
  'POSTGRES_PASSWORD',
  'DATABASE_URL',
  'password',
  'passwordHash',

  // Header casings we see on fetch logs
  'authorization',
  'Authorization',
  'cookie',
  'Cookie',
  'x-worker-secret',
  'X-Worker-Secret',

  // Nested forms
  '*.ANTHROPIC_API_KEY',
  '*.FINNHUB_API_KEY',
  '*.TIINGO_API_KEY',
  '*.FRED_API_KEY',
  '*.ALPACA_SECRET_KEY',
  '*.ALPACA_KEY_ID',
  '*.TAVILY_API_KEY',
  '*.CODEMAGIC_API_TOKEN',
  '*.TELEGRAM_BOT_TOKEN',
  '*.TELEGRAM_CHAT_ID',
  '*.WORKER_SECRET',
  '*.ADMIN_PASSWORD_HASH',
  '*.ADMIN_PASSWORD_HASH_B64',
  '*.ADMIN_PASSWORD',
  '*.SESSION_SECRET',
  '*.POSTGRES_PASSWORD',
  '*.DATABASE_URL',
  '*.password',
  '*.passwordHash',
  '*.authorization',
  '*.Authorization',
  '*.cookie',
  '*.Cookie',
  '*.x-worker-secret',
  '*.X-Worker-Secret',

  // Common header bag locations
  'headers.authorization',
  'headers.Authorization',
  'headers.cookie',
  'headers.Cookie',
  'headers["x-worker-secret"]',
  'headers["X-Worker-Secret"]',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-worker-secret"]',
  'request.headers.authorization',
  'request.headers.cookie',
  'request.headers["x-worker-secret"]',
];

// ---------------------------------------------------------------------------
// Service name detection
// ---------------------------------------------------------------------------

function detectServiceName(): string {
  const explicit = process.env['SERVICE_NAME'];
  if (explicit && explicit.length > 0) return explicit;

  // Fallback: infer from the main script path. `apps/worker/...` → 'worker'.
  const main = process.argv[1] ?? '';
  if (main.includes('/apps/worker/') || main.includes('\\apps\\worker\\')) {
    return 'worker';
  }
  if (
    main.includes('/apps/web/') ||
    main.includes('\\apps\\web\\') ||
    main.includes('next-server')
  ) {
    return 'web';
  }
  return 'vantage';
}

// ---------------------------------------------------------------------------
// Singleton builder
// ---------------------------------------------------------------------------

let _root: Logger | null = null;

export function getLogger(): Logger {
  if (_root) return _root;

  const level = process.env['LOG_LEVEL'] ?? 'info';
  const isDev = process.env['NODE_ENV'] !== 'production';
  const serviceName = detectServiceName();

  const base = {
    service: serviceName,
    pid: process.pid,
    hostname: osHostname(),
  };

  // pino's err serializer already walks `.cause` on modern Node and emits stack
  // traces; we keep it explicitly so downstream callers don't have to remember
  // to pass `{ err }`.
  const options: LoggerOptions = {
    level,
    base,
    redact: {
      paths: [...REDACT_PATHS],
      censor: '[Redacted]',
    },
    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err,
    },
  };

  if (isDev) {
    options.transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss.l',
        ignore: 'pid,hostname',
      },
    };
  }

  _root = pino(options);
  return _root;
}

/**
 * Test hook — reset the singleton so a test can reconfigure the env and get a
 * fresh instance.
 */
export function __resetLogger(): void {
  _root = null;
}

/**
 * Convenience: child logger with a `component` binding. Prefer this over
 * `getLogger().child({ component: '...' })` at call sites so the shape stays
 * consistent across the repo.
 */
export function componentLogger(component: string, extra: Record<string, unknown> = {}): Logger {
  return getLogger().child({ component, ...extra });
}

// ---------------------------------------------------------------------------
// Auto-serialize helpers
// ---------------------------------------------------------------------------

/**
 * Normalize anything into a context object suitable for pino. If `err` is an
 * Error, we serialize it via pino's stdSerializer so stack + cause show up in
 * structured form. Otherwise we pass through untouched.
 */
function normalizeContext(ctx?: Record<string, unknown> | Error | null): Record<string, unknown> {
  if (ctx === undefined || ctx === null) return {};
  if (ctx instanceof Error) {
    return { err: pino.stdSerializers.err(ctx) };
  }
  // If any value is an Error, serialize it in place.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx)) {
    out[k] = v instanceof Error ? pino.stdSerializers.err(v) : v;
  }
  return out;
}

export function logInfo(message: string, context?: Record<string, unknown>): void {
  getLogger().info(normalizeContext(context), message);
}

export function logWarn(message: string, context?: Record<string, unknown> | Error): void {
  getLogger().warn(normalizeContext(context), message);
}

export function logError(message: string, context?: Record<string, unknown> | Error): void {
  getLogger().error(normalizeContext(context), message);
}

export function logDebug(message: string, context?: Record<string, unknown>): void {
  getLogger().debug(normalizeContext(context), message);
}

export type { Logger } from 'pino';
