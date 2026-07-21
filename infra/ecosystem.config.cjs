// Legacy pm2 config — primary deployment is now docker compose (see
// infra/docker-compose.yml). Kept for emergency fallback / debugging on a
// host where Docker is unavailable.
/**
 * PM2 ecosystem config for Vantage (production on Windows 11 gaming PC).
 *
 * Usage:
 *   pm2 start infra/ecosystem.config.cjs
 *   pm2 reload infra/ecosystem.config.cjs --update-env
 *   pm2 save
 *   pm2 startup                   # Linux / macOS
 *   pm2-startup install           # Windows (via `npm i -g pm2-windows-startup`)
 *
 * Env loading:
 *   Both apps load the project-root `.env` via `infra/env-preload.cjs`,
 *   injected through `NODE_OPTIONS="--require <abs-path>"`. This is more
 *   reliable than PM2's own `env_file` (which is broken / inconsistent in
 *   6.0.x). Make sure `.env` is complete before `pm2 start`:
 *     DATABASE_URL, SESSION_SECRET (32+ chars), ADMIN_PASSWORD_HASH,
 *     WORKER_SECRET, ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN,
 *     TELEGRAM_CHAT_ID, FINNHUB_API_KEY, TIINGO_API_KEY, FRED_API_KEY,
 *     ALPACA_KEY_ID, ALPACA_SECRET_KEY, DASHBOARD_BASE_URL, WORKER_URL,
 *     EDGAR_USER_AGENT.
 *
 * Paths:
 *   All paths use forward slashes — PM2 normalizes for Windows. The web
 *   app's `cwd` is `apps/web` so `next start` resolves `.next/` output
 *   correctly; the worker's `cwd` is the project root so Prisma's bundled
 *   engine resolves from `packages/db/generated/`.
 */

const path = require('node:path');

// Resolve project root from this file's location: infra/ -> ..
const projectRoot = path.resolve(__dirname, '..').replace(/\\/g, '/');
const preload = `${projectRoot}/infra/env-preload.cjs`;
const logDir = `${projectRoot}/logs`;

/** Shared runtime options. */
const common = {
  interpreter: 'node',
  autorestart: true,
  max_memory_restart: '512M',
  restart_delay: 2000,
  exp_backoff_restart_delay: 200,
  max_restarts: 10,
  min_uptime: '30s',
  kill_timeout: 10000,
  merge_logs: true,
  time: true,
  log_date_format: 'YYYY-MM-DD HH:mm:ss.SSS Z',
};

module.exports = {
  apps: [
    {
      ...common,
      name: 'vantage-web',
      cwd: `${projectRoot}/apps/web`,
      // pnpm hoists `next` into `apps/web/node_modules` — resolve from there.
      script: `${projectRoot}/apps/web/node_modules/next/dist/bin/next`,
      // -H 0.0.0.0 forces IPv4 + IPv6 dual-stack bind. Without it, Next 15 on
      // Windows binds to `::` only (IPv6 unspecified) which makes the dashboard
      // unreachable over Tailscale (tailnet is IPv4: 100.x.x.x).
      args: 'start -p 3000 -H 0.0.0.0',
      env: {
        NODE_ENV: 'production',
        PORT: '3000',
        HOSTNAME: '0.0.0.0',
        // --require pre-loads the .env into process.env before `next start`.
        NODE_OPTIONS: `--require ${preload}`,
      },
      error_file: `${logDir}/web.error.log`,
      out_file: `${logDir}/web.out.log`,
      pid_file: `${logDir}/web.pid`,
    },
    {
      ...common,
      name: 'vantage-worker',
      cwd: projectRoot,
      script: `${projectRoot}/apps/worker/dist/index.js`,
      env: {
        NODE_ENV: 'production',
        NODE_OPTIONS: `--require ${preload}`,
      },
      error_file: `${logDir}/worker.error.log`,
      out_file: `${logDir}/worker.out.log`,
      pid_file: `${logDir}/worker.pid`,
    },
  ],
};
