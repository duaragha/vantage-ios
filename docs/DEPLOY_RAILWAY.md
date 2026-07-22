# Railway deployment

Vantage deploys from `duaragha/vantage` on GitHub as four application services
plus a pgvector-compatible Postgres service. The application services track
the `main` branch; Postgres continues to use the `pgvector/pgvector:pg16`
image. Only `web` gets a public domain. The worker, embed API, embed cron and
database stay on Railway's private network.

This layout keeps the dashboard and schedulers warm, but moves the roughly
800 MiB local embedding model out of the always-on worker. Semantic chat wakes
the private embed API on demand; stored article and thesis embeddings are
filled by an hourly one-shot cron.

## Services

| Railway service | Config file                      | Network                 | Runtime policy     | Suggested cap           |
| --------------- | -------------------------------- | ----------------------- | ------------------ | ----------------------- |
| `web`           | `/infra/railway/web.json`        | public domain + private | always on          | 1 vCPU / 512 MiB        |
| `worker`        | `/infra/railway/worker.json`     | private only            | always on          | 1 vCPU / 512 MiB        |
| `embed-api`     | `/infra/railway/embed-api.json`  | private only            | serverless sleep   | 1 vCPU / 1.5 GiB        |
| `embed-cron`    | `/infra/railway/embed-cron.json` | private only            | hourly UTC cron    | 1 vCPU / 1.5 GiB        |
| `postgres`      | `pgvector/pgvector:pg16` image   | private only            | always on + volume | start at 1 vCPU / 1 GiB |

The limits are safety ceilings, not reservations. Check real usage after seven
days before tightening them. Do not use a shared-workspace hard usage limit to
control Vantage because it can suspend unrelated projects such as Locket or
Konpeki.

## Create and connect the services

1. Create a Railway project and deploy `pgvector/pgvector:pg16` as `postgres`.
   Mount a volume at `/var/lib/postgresql/data` and set
   `PGDATA=/var/lib/postgresql/data/pgdata`; the subdirectory avoids the
   mount's `lost+found` entry blocking `initdb`.
2. Add four empty application services, connect each one to
   `duaragha/vantage` on the `main` branch, and set its config-file path from
   the table above. Railway then deploys only when that service's watch
   patterns match a pushed change. Use `railway up -s <service>` only as a
   break-glass deployment path when GitHub is unavailable.
3. Railway creates the private `*.railway.internal` names automatically.
   Generate a public Railway or custom domain only for `web`.
4. Turn Serverless on for `embed-api`. Leave it off for `web`, `worker`, the
   database and `embed-cron`.
5. Set `worker` and Postgres in the same Railway region. Keep all four app
   services in that region unless latency measurements show a reason to move.

The config files select the Dockerfiles, health checks, restart policies,
resource ceilings and the hourly embed cron. Railway service settings still
own domains, private networking, volumes and secrets.

## Variables

Use Railway variable references instead of copying credentials between
services. The minimum service-specific wiring is:

### Shared by web, worker, embed API and embed cron

```dotenv
DATABASE_URL=postgresql://${{postgres.POSTGRES_USER}}:${{postgres.POSTGRES_PASSWORD}}@postgres.railway.internal:5432/${{postgres.POSTGRES_DB}}
NODE_ENV=production
```

Use a URL-safe generated Postgres password, such as 64 hex characters, or
percent-encode it before composing this URL. Confirm that the resolved host is
`postgres.railway.internal` before importing any data.

### Web

```dotenv
PORT=3000
HOSTNAME=0.0.0.0
WORKER_URL=http://worker.railway.internal:3001
WORKER_SECRET=<same generated value as worker>
EMBEDDER_URL=http://embed-api.railway.internal:3002
EMBEDDER_SECRET=<same generated value as embed-api>
DASHBOARD_BASE_URL=https://${{web.RAILWAY_PUBLIC_DOMAIN}}
CAPACITOR_SERVER_URL=https://${{web.RAILWAY_PUBLIC_DOMAIN}}
SESSION_SECRET=<long random value>
WEB_PUSH_PUBLIC_KEY=<shared VAPID public key>
```

Keep the existing dashboard password/session, Codemagic and provider variables
used by web routes. Leave the legacy `TAILSCALE_BASE_URL` unset on Railway;
SideStore uses `DASHBOARD_BASE_URL` first.

The Capacitor wrapper and root `codemagic.yaml` must use the
same public Railway URL. An already-installed IPA keeps its previously baked
server URL until a new mobile build is installed.

### Worker

```dotenv
PORT=3001
WORKER_PORT=3001
WORKER_HOST=0.0.0.0
WORKER_SECRET=<same generated value as web>
DASHBOARD_BASE_URL=https://${{web.RAILWAY_PUBLIC_DOMAIN}}
WEB_PUSH_PUBLIC_KEY=<same VAPID public key as web>
WEB_PUSH_PRIVATE_KEY=<VAPID private key, worker only>
WEB_PUSH_SUBJECT=https://${{web.RAILWAY_PUBLIC_DOMAIN}}
```

Copy the existing Anthropic, Finnhub, Tiingo, FRED, Alpaca, Tavily and optional
provider values. Leave legacy Telegram variables unset when Vantage app push is
the only phone channel. Disabled integrations should remain explicitly disabled
instead of receiving placeholder keys.

### Embed API

```dotenv
PORT=3002
EMBEDDER_HOST=0.0.0.0
EMBEDDER_SECRET=<same generated value as web>
EMBED_SWEEP_INTERVAL_MS=0
```

### Embed cron

```dotenv
EMBED_MAX_ROWS=1000
EMBED_QUERY_BATCH_SIZE=128
```

The cron schedule is UTC (`0 * * * *`). It exits after each bounded sweep, so
Railway bills model memory only while the batch runs.

## Database cutover

Do not point the apps at an empty Railway database and call it migrated. The
current Postgres volume contains the portfolio, research history, alerts,
cost ledger and pgvector columns.

1. Take and verify a fresh source backup using the existing Windows deployment
   procedure.
2. Put Vantage in a short write-maintenance window by stopping the worker.
3. Export from source with `pg_dump` and restore to the Railway private
   Postgres endpoint from an authorized shell or tunnel.
4. Run `prisma migrate deploy` against the restored Railway database. The
   worker's startup gate handles subsequent deploys before its health check can
   pass.
5. Compare source and destination row counts for positions, theses, articles,
   market events, alerts, chat messages and LLM calls.
6. Start `embed-cron` once manually and confirm the remaining-null counts fall.
7. Start the worker, then web, and exercise the checks below before changing
   the mobile URL or retiring the old deployment.

Enable Railway backups for the Postgres volume before the cutover. Keep the
verified source backup until at least one Railway restore drill succeeds.

## Release checks

Run these before directing normal traffic to Railway:

```bash
curl -fsS "https://<web-domain>/api/health"
curl -fsS -H "x-worker-secret: <secret>" \
  "http://<worker-private-domain>/health"
curl -fsS "http://<embed-api-private-domain>/health"
```

Then verify in the UI:

- dashboard login and portfolio data
- one chat question that needs article context, with cited semantic results
- manual provider poll and one normal scheduler cycle
- Vantage app subscription, test notification, and durable outbox delivery
- SideStore/mobile endpoints using the Railway public base URL
- `/ops` cost totals and both LLM spend caps

After seven full days, inspect per-service CPU, memory, egress and volume usage.
The target is roughly `$7-$9/month` of Railway infrastructure at the measured
idle profile, not including Anthropic or other metered APIs. If Vantage trends
above `$10/month`, find the service responsible before relaxing a cap. Model
memory should appear on `embed-api` only around chat requests and on
`embed-cron` only during its hourly run, never as worker baseline memory.

Export each service's seven-day averages into a small JSON file, then run the
same rates used by the estimate with a failing budget check:

```bash
pnpm cost:railway metrics.json --check
```

The input is `{ "budgetUsd": 10, "services": [...] }`; each service accepts
`name`, `avgMemoryGb`, `avgCpu`, `egressGb`, and `volumeGb`. The report shows
memory, CPU, egress and volume cost separately so a regression has an owner.

## Rollback

Keep the current Docker Compose deployment stopped but intact during the first
Railway validation window. If a release check fails, stop the Railway worker,
restore the source deployment, and reverse any public/mobile URL change. Never
run both workers against the same writable database because both will dispatch
jobs and alerts.
