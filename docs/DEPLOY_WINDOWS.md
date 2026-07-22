# Deploying Vantage to the gaming PC

Vantage runs only on the always-on Windows gaming PC. The source tree and
deployment commands live on this Linux machine; Docker executes remotely through
the `gamingpc` context. Never create a local/default-context Vantage stack.

Production dashboard:

```text
https://raghavsgamingpc.tail4d6220.ts.net:3500
```

## Prerequisites

The PC must be awake with Docker Desktop, OpenSSH, and Tailscale running. Verify
the target before every deploy:

```bash
tailscale ping -c 1 raghavsgamingpc
docker --context gamingpc info
docker --context gamingpc compose --env-file .env -f infra/docker-compose.yml ps
```

If the Tailscale ping fails, stop. Do not fall back to local Docker.

The repo-root `.env` is read by Compose on this machine and injected into the
remote containers. Required production values include:

| Key                                                 | Purpose                                                                      |
| --------------------------------------------------- | ---------------------------------------------------------------------------- |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | Live Postgres credentials                                                    |
| `SESSION_SECRET`                                    | 32+ character iron-session signing secret                                    |
| `ADMIN_PASSWORD_HASH_B64`                           | Break-glass login hash; the DB hash is authoritative after a password change |
| `WORKER_SECRET`                                     | Web-to-worker authentication                                                 |
| `ANTHROPIC_API_KEY`                                 | Chat, digests, and research synthesis                                        |
| `FINNHUB_API_KEY`, `TIINGO_API_KEY`, `FRED_API_KEY` | Market and macro sources                                                     |
| `ALPACA_KEY_ID`, `ALPACA_SECRET_KEY`                | US live-price source                                                         |
| `TAVILY_API_KEY`                                    | Optional cited news search in Chat                                           |
| `WEB_PUSH_PUBLIC_KEY`, `WEB_PUSH_PRIVATE_KEY`       | Vantage app notification signing keys                                        |
| `WEB_PUSH_SUBJECT`                                  | HTTPS Vantage origin used as the VAPID subject                               |
| `EDGAR_USER_AGENT`                                  | SEC-required descriptive user agent and email                                |
| `DASHBOARD_BASE_URL`                                | `https://raghavsgamingpc.tail4d6220.ts.net:3500`                             |
| `TZ`                                                | `America/Toronto`                                                            |

Keep the local secret file owner-only:

```bash
chmod 600 .env
```

The guarded deploy script rejects group- or world-readable `.env` permissions.

App notification setup and iPhone installation are documented in
[`APP_NOTIFICATIONS.md`](./APP_NOTIFICATIONS.md).

## Pre-deploy verification

The guarded deploy script is the primary release path. It is permanently locked
to `gamingpc` (`ssh://docker-pc`) and stops before migration unless the PC is
reachable, the external volume exists, and a custom-format database backup
passes `pg_restore --list` validation:

```bash
./infra/deploy-docker-to-pc.sh
```

Use `--dry-run` to inspect the sequence without contacting Docker. Use
`--skip-gates` only when the exact source tree being deployed has already passed
the full gate set below. The script still performs backup, migration, container
health, non-root runtime, private-file, and public URL checks.

The equivalent complete local gates are:

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm lint
pnpm build
DATABASE_URL="$(grep -E '^DATABASE_URL=' .env | cut -d= -f2-)" \
  pnpm --filter @vantage/db exec prisma validate
```

## Back up the live database

Create a custom-format dump before applying migrations. The redirect writes the
backup to this machine while `pg_dump` executes inside the PC container.

```bash
umask 077
mkdir -p backups
docker --context gamingpc compose --env-file .env -f infra/docker-compose.yml \
  exec -T postgres sh -lc 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > "backups/vantage-$(date +%Y%m%d-%H%M%S).dump"
```

Verify the file is non-empty and readable with `pg_restore --list` before
migrating.

The guarded deploy script performs this automatically, writes through a
`.partial` file, and records a SHA-256 checksum only after the dump validates.

## Build, migrate, deploy

The commands below are the manual recovery path. Normal releases should use
`./infra/deploy-docker-to-pc.sh` so a step cannot be accidentally skipped.

Build first without recreating the running containers. This keeps the current
version serving while the images compile:

```bash
docker --context gamingpc compose --env-file .env -f infra/docker-compose.yml \
  build web worker
```

Apply migrations using the newly built worker image against the live Postgres
service:

```bash
docker --context gamingpc compose --env-file .env -f infra/docker-compose.yml \
  run --rm --no-deps worker \
  pnpm --filter @vantage/db exec prisma migrate deploy
```

Then replace only the application services. The external Postgres volume is not
recreated:

```bash
docker --context gamingpc compose --env-file .env -f infra/docker-compose.yml \
  up -d --no-deps web worker
```

For a first boot where Postgres is not already running, start it before the
migration:

```bash
docker --context gamingpc compose --env-file .env -f infra/docker-compose.yml \
  up -d postgres
```

## Acceptance checks

```bash
docker --context gamingpc compose --env-file .env -f infra/docker-compose.yml ps
docker --context gamingpc compose --env-file .env -f infra/docker-compose.yml \
  logs --since 10m web worker
curl -fsS https://raghavsgamingpc.tail4d6220.ts.net:3500/api/health
```

Confirm `vantage-postgres` is healthy, web and worker are running, migrations
show no pending rows, and the public tailnet URL serves the current build. Use
the authenticated acceptance steps in the active fix spec for feature-level
verification.

## Persistence and startup

The stack uses `restart: unless-stopped`; Docker Desktop must start at Windows
login and the PC must not sleep. Live data remains in the external
`equity_agent_pgdata` volume. Never run `compose down -v`, delete that volume, or
recreate Postgres without a verified backup.

The legacy PM2 files remain only for historical fallback. They are not the
production deployment path.
