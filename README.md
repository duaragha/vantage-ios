# Vantage

Personal AI equity-research and portfolio-optimization agent. Self-hosted
service that monitors my stock portfolio, ingests news / SEC filings /
earnings / macro / sentiment from free sources, evaluates each thesis
against fresh evidence, and surfaces event-driven alerts plus scheduled
digests in Vantage and through its installable phone app.

Advisory only. Never places trades.

## Development

Prereqs on the laptop: Node 20+ and pnpm 10+. Docker is not installed or run
on the laptop. The only Docker target is the gaming PC through the `gamingpc`
context (SSH endpoint `docker-pc`).

### Host-side checks

```bash
pnpm install
pnpm -r typecheck
pnpm -r build

# Any Docker command must name the remote PC context explicitly.
docker --context gamingpc compose --env-file .env -f infra/docker-compose.yml ps
```

The dashboard is exposed to the tailnet at
<https://raghavsgamingpc.tail4d6220.ts.net:3500>. Database migrations and seed
commands run inside the remote worker container; see the production walkthrough
below. Never run an unqualified `docker compose` command for Vantage.

## Production deploy

Full walkthrough in [`docs/DEPLOY_WINDOWS.md`](docs/DEPLOY_WINDOWS.md).
Target setup: always-on Windows 11 box, docker compose for web + worker +
Postgres, Tailscale as the network surface for the dashboard.

The cost-optimized Railway topology and cutover checklist are in
[`docs/DEPLOY_RAILWAY.md`](docs/DEPLOY_RAILWAY.md). It keeps the live worker
small and moves local embedding inference to a sleeping private API plus an
hourly batch service.

```bash
./infra/deploy-docker-to-pc.sh
```

This command is locked to the `gamingpc` Docker context. It verifies a live
database backup before migration and waits for both application containers to
become healthy.

Supporting docs:

- [`docs/APP_NOTIFICATIONS.md`](docs/APP_NOTIFICATIONS.md) — installing Vantage
  on iPhone and enabling app notifications
- [`docs/FIRST_RUN.md`](docs/FIRST_RUN.md) — bootstrapping your positions
  and triggering the first digest

## Architecture

Full architecture + phase-by-phase task log in
[`docs/spec.md`](docs/spec.md).

### Stack

- **Frontend** — Next.js 15 (App Router), React 19, Tailwind v4, shadcn/ui, Recharts v3
- **Backend** — Next.js route handlers + standalone Node + Fastify worker
- **Jobs** — `croner` inside the worker process, with an independent watchdog
- **DB** — Postgres 16 + pgvector, Prisma
- **LLM** — `@anthropic-ai/sdk` with prompt caching + tiered models (Haiku / Sonnet / Opus)
- **Embeddings** — local `bge-small-en-v1.5` behind a private on-demand service
- **Notifications** — standards-based Web Push with a durable worker outbox

### Repo layout

```
vantage/
├── apps/
│   ├── web/              # Next.js dashboard
│   ├── worker/           # Fastify + Croner background service
│   └── embedder/         # Private embedding API + one-shot batch entrypoint
├── packages/
│   ├── db/               # Prisma schema + client
│   ├── core/             # Domain logic
│   ├── sources/          # Data source adapters
│   ├── llm/              # Anthropic client wrapper
│   ├── embed/            # Local embeddings
│   └── notify/           # Vantage app push + legacy Telegram/self-alert
├── infra/
│   ├── docker-compose.yml
│   ├── ecosystem.config.cjs    # Legacy PM2 fallback
│   ├── env-preload.cjs         # PM2 env loader (legacy)
│   └── cloudflared/            # (legacy — Tailscale replaced this)
└── docs/
    ├── spec.md
    ├── DEPLOY_WINDOWS.md
    ├── APP_NOTIFICATIONS.md
    └── FIRST_RUN.md
```

## Accounts to register (cold-start reference)

Keys live in the repo-root `.env` on this Linux machine; Compose injects them
into the remote PC containers. Never commit or copy that file into an image.

| Service   | Sign-up URL                                             | Used for                                 |
| --------- | ------------------------------------------------------- | ---------------------------------------- |
| Anthropic | <https://console.anthropic.com>                         | Claude (Haiku / Sonnet / Opus)           |
| Finnhub   | <https://finnhub.io/register>                           | news, earnings calendar, quotes          |
| Tiingo    | <https://www.tiingo.com/account/api/token>              | US universe, history fallback, backtests |
| FRED      | <https://fred.stlouisfed.org/docs/api/api_key.html>     | macro series                             |
| Alpaca    | <https://alpaca.markets/signup> (paper account is fine) | intraday quotes + bars, WebSocket stream |
| Tavily    | <https://app.tavily.com>                                | cited financial-news search in Chat      |

Vantage app notification setup is in
[`docs/APP_NOTIFICATIONS.md`](docs/APP_NOTIFICATIONS.md).

## What runs automatically

All cron entries run in `America/Toronto`. Polls fire on weekdays only unless noted.

| Cadence                | Job                         | What it does                                                                                     |
| ---------------------- | --------------------------- | ------------------------------------------------------------------------------------------------ |
| every 5 min¹           | `poll.news`                 | Finnhub headlines plus approved StockTwits access                                                |
| every 5 min¹           | `poll.filings`              | EDGAR filings → 8-K MarketEvents (10-Q/10-K polled hourly)                                       |
| every min (04-19 ET)²  | `poll.prices`               | Live held/scanner prices, move events, stop and target alerts                                    |
| every 15 min¹          | `poll.earnings`             | Finnhub earnings calendar + actuals → EarningsBeat events                                        |
| every 15 min¹          | `poll.marketNews`           | Market-wide news for the discovery scorer                                                        |
| every 30 min (9-16 ET) | `poll.insiders`             | Finnhub insider transactions → InsiderCluster events                                             |
| every 5 min (9-16 ET)  | `catalyst.run`              | Gated exceptional-opportunity fast lane — see [docs/CATALYST_ENGINE.md](docs/CATALYST_ENGINE.md) |
| 06:00 ET               | `poll.macro`                | FRED macro series                                                                                |
| 07:00 ET               | `poll.analysts`             | Finnhub analyst recommendation trends → AnalystUpgrade events                                    |
| 07:00 ET               | `digest.morning`            | Pre-market digest → Vantage app                                                                  |
| 10:30, 13:30 ET        | `discover.compute.cached`   | Re-rank discovery from cached market data                                                        |
| 16:30 ET               | `digest.evening`            | Post-close digest → Vantage app                                                                  |
| 16:45 ET               | `thesis.batch`              | Re-evaluate every open thesis                                                                    |
| 17:00 ET               | `poll.eodHistory`           | Alpaca US + Yahoo Canada daily bars, with bounded Tiingo fallback                                |
| 18:00 ET               | `discover.compute`          | Nightly discovery score recompute                                                                |
| daily 01:30 ET         | `quality.lottery`           | Flag sub-$5, extreme-volatility lottery tickers                                                  |
| daily 02:00 ET         | `poll.fundamentals`         | Refresh stale statements and ratios                                                              |
| daily 03:00 ET         | `goals.snapshot`            | Persist goal progress and off-track transitions                                                  |
| daily 03:15 ET         | `backfill.profiles`         | Enrich newly seeded US listings with sector and market cap                                       |
| daily 03:30 ET         | `db.retention`              | Bounded retention sweep for operational tables (JobRun, outbox, old events)                      |
| Sat 10:00 ET           | `digest.discovery`          | Saturday market-discovery digest                                                                 |
| Sun 06:00 ET           | `poll.tickerUniverse`       | Refresh symbol universe (US + enabled Canadian exchanges)                                        |
| Sun 20:00 ET           | `digest.weeklyDeepDive`     | Opus weekly cross-position synthesis                                                             |
| 1st of month, 09:00 ET | `digest.monthlyAllocation`  | Monthly allocation digest                                                                        |
| every 30s³             | `alert.dispatch`            | Sweep MarketEvents into Alert Insights + durable queue                                           |
| every 30s³             | `app-notification.dispatch` | Deliver and retry the durable Vantage app outbox                                                 |
| every 30s³             | `telegram.dispatch`         | Legacy Telegram outbox, inactive when its environment variables are unset                        |
| every 30 min           | `watchdog.jobs`             | Independently detect scheduled jobs that missed their expected slot                              |

¹ Thinned overnight (22:00-06:00 ET): the 5-minute pollers drop to every
30 minutes and the 15-minute pollers to hourly (`lib/pollCadence.ts`).
² Per-minute in the regular session only; every 5 minutes pre/after-hours and
every 15 minutes on US market holidays.
³ Prechecked: ticks with an empty queue skip without a JobRun row (the
in-process tick registry keeps the watchdog and deep health accurate), with a
forced real run at least every 15 minutes.

Weekend price and rebalance polling is intentionally quiet. Vantage is a
buy-and-hold research tool, the exchanges are closed, and stale weekend marks
would create noise rather than actionable drift. Sunday still gets the weekly
deep-dive, and price coverage resumes at 04:00 ET Monday.

## Scripts

| Command          | What it does                             |
| ---------------- | ---------------------------------------- |
| `pnpm dev`       | Run web + worker in parallel (host-side) |
| `pnpm build`     | Build all packages                       |
| `pnpm typecheck` | `tsc --noEmit` across every package      |
| `pnpm lint`      | ESLint across the repo                   |
| `pnpm format`    | Prettier write                           |

## Security

- `.env` is gitignored. Never commit real API keys.
- `.env.example` is the committed placeholder — keep it in sync when you
  add a new env var.
- Tailscale terminates the network path; the dashboard is only reachable
  from devices on the tailnet (no inbound ports open on the home network).
- Dashboard is password-gated (iron-session) and worker HTTP is
  secret-gated (`x-worker-secret`).
- Self-alert fires over Telegram for any failed job, missed schedule, or spend-cap breach.

## License

Personal use only. Not open-source. Not investment advice.
