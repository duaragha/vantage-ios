# Spec: Vantage — Personal Equity Research & Portfolio Optimization Agent

## Overview

**What**: A personal, self-hosted AI agent + dashboard that watches Raghav's stock portfolio, ingests market news / filings / earnings / macro / social sentiment from free data sources, evaluates each position's thesis, surfaces event-driven alerts and scheduled digests via Telegram, and proposes specific buy/trim/rotate actions within a user-defined monthly allocation budget. Research and advisory only — the agent never places trades.

**Why**: Raghav is a Canadian retail investor on Wealthsimple (no broker API) with a concentrated, emerging-tech-heavy portfolio that includes both conviction and "saw it on Reddit" positions. He needs a junior-analyst-grade assistant that remembers his theses, monitors catalysts, forces discipline around diversification, and tells him where to deploy fresh capital — without sinking hours into manual research.

**Scope — in**:

- Portfolio + thesis + watchlist CRUD (manual entry + CSV paste import)
- Free-tier data ingestion across Alpaca (US intraday + daily bars), Finnhub (news/earnings/profile), Yahoo Finance (Canadian quotes/history/fundamentals), bounded Tiingo history fallback + backtests, FRED (macro), SEC EDGAR (filings), and optional approved StockTwits access (tier-3 sentiment)
- Structured thesis model (pillars + risk factors, not free-text blobs)
- Two scheduled digests per trading day (7:00am ET pre-market, 4:30pm ET post-close) delivered via Telegram
- Event-triggered alerts: earnings releases, 8-K filings, breaking news on holdings, >N% intraday moves (configurable)
- Monthly allocation deployment digest (1st of each calendar month) proposing specific buys within `monthly_budget` and hard diversification caps
- Inline rebalancing/rotation suggestions within daily digests
- Weekly Sunday Opus deep dive (cross-position synthesis + diversification audit)
- Web dashboard with command-center aesthetic: portfolio overview with thesis health, insights feed, per-position thesis view, watchlist, catalyst calendar, chat interface, settings
- Claude-powered reasoning with model tiering (Haiku 4.5 for filters, Sonnet 4.6 for synthesis, Opus 4.7 for weekly deep dive)
- Prompt caching on portfolio/thesis context
- Source-tier trust system + dedup + satire-domain blocklist
- Chat RAG over articles + theses via pgvector + local embeddings
- Backtest harness for rebalancing strategies against historical prices
- Bought/Passed action buttons on every actionable insight with persisted feedback + cooldown
- Self-hosted in Docker on Raghav's gaming PC, exposed privately through Tailscale Serve

**Scope — out**:

- **Automated trade execution** — never, regulatory (Wealthsimple has no broker API, and we're advisory-only regardless)
- **Multi-user auth / tenancy** — single-user only by design
- **Mobile app** — Telegram covers mobile delivery
- **Full DCF / paid institutional datasets** — Vantage surfaces the statements and ratios available from its free providers, but does not pretend that sparse data is a full valuation model

## Requirements

### Functional

- [ ] Manual portfolio CRUD with fields: ticker, shares, avg_cost, category tag, thesis
- [ ] CSV paste import: user pastes `ticker,shares,avg_cost,category` block on a bulk-import page; preview + confirm before write
- [ ] Structured thesis: `summary`, `pillars[]` (2-4 statements that must be true), `riskFactors[]`, `createdAt`, `lastValidatedAt`, `status` (Intact/Strengthening/Weakening/Broken)
- [ ] Watchlist CRUD — tickers Raghav is tracking but doesn't own
- [ ] User settings: `monthlyBudget`, `singlePositionCapPct`, `sectorCapPct`, `intradayMoveThresholdPct`, `passCooldownDays`, Telegram chat_id, spend caps, kill switch
- [ ] Daily pre-market digest at 7:00am ET: overnight news on holdings, pre-market movers, earnings today, catalysts to watch
- [ ] Daily post-close digest at 4:30pm ET: day recap, after-hours earnings, tomorrow's calendar, thesis status changes
- [ ] Monthly allocation digest on 1st of month proposing 1-3 specific buys within budget, respecting caps
- [ ] Weekly Opus deep dive Sunday 8pm ET: cross-position synthesis, diversification audit, stale-thesis flag
- [ ] Event triggers fire within 10 min of detection: earnings (vs. expectations), 8-K filings, breaking news, >N% intraday moves
- [ ] Every rebalancing/deployment suggestion includes: reasoning, cited data points, specific action (exact share count), confidence level (Low/Medium/High)
- [ ] Dedup: identical story from multiple outlets collapses to one canonical entry
- [ ] Dashboard pages: portfolio overview, insights feed (chronological), per-position thesis view, watchlist, catalyst calendar (next 14 days), chat, settings, ops (internal)
- [ ] Chat interface backed by Claude with pgvector retrieval over Articles + ThesisEvaluations + portfolio context
- [ ] **Bought** / **Passed** action buttons on every actionable insight, persisted
  - Bought opens pre-filled Position form (ticker, shares, price snapshot as avg cost candidate)
  - Passed marks insight + applies per-ticker cooldown (default 14d) before re-suggesting same action
- [ ] Backtest harness: given `{strategy, startDate, endDate, caps}`, replay buys/rebalances against Tiingo historical prices, output return vs SPY benchmark

### Non-functional

- [ ] Free-tier data only (Alpaca paper, Finnhub free, Tiingo free, FRED free, EDGAR, and approved StockTwits access when available)
- [ ] Claude API spend tuned below $10/mo steady-state; new installs default to a $10/mo hard cap with a kill switch flag in DB
- [ ] Per-ticker event-alert cap: 3/day (prevents runaway spend during news-heavy days)
- [ ] Digests degrade gracefully if any single source rate-limits (ship partial, note which sources failed in footer)
- [ ] Every LLM factual claim must cite a source or be stripped
- [ ] Prompt caching (5-min TTL) on portfolio + thesis context
- [ ] Source tiering: tier-1 (Reuters, Bloomberg, AP, SEC) > tier-2 (general news) > tier-3 (blogs, archived social, approved StockTwits) — tier-1 corroboration required for strong claims or >10% budget buys
- [ ] Satire-domain blocklist enforced before any article reaches the LLM
- [ ] Keyword pre-filter before Haiku relevance check: only articles whose text contains a held/watchlist ticker (or company name alias) reach the LLM
- [ ] Dashboard dark mode default (command-center aesthetic), WCAG AA contrast on text
- [ ] Deploy target: Raghav's gaming PC (Windows 11, 24/7 on), Docker Postgres, Tailscale HTTPS for dashboard exposure
- [ ] Dev environment: laptop (Linux Mint) for host-side Node checks only; all Docker commands target the remote `gamingpc` context

## Architecture / Design

### Repo shape (pnpm monorepo)

```
~/Documents/Projects/personal_projects/vantage/
├── docs/
│   └── spec.md
├── apps/
│   ├── web/              # Next.js 15 App Router dashboard + API route handlers
│   └── worker/           # Node+Fastify background service: scheduler, pollers, ingestion, alert/digest pipeline
├── packages/
│   ├── db/               # Prisma schema + client (shared) + pgvector migration
│   ├── core/             # Domain logic: thesis evaluation, rebalance, digest, backtest, prompt builders
│   ├── sources/          # Adapters: alpaca, finnhub, edgar, tiingo, fred, stocktwits, twelvedata, yfinance
│   ├── llm/              # Anthropic client, model tiering, caching, structured outputs, spend tracking
│   ├── embed/            # Local embedding via @xenova/transformers (bge-small-en-v1.5)
│   └── notify/           # Telegram adapter
├── infra/
│   ├── docker-compose.yml        # production Postgres + web + worker on gamingpc
│   ├── deploy-to-pc.sh           # legacy PM2 fallback
│   └── cloudflared/config.yml    # legacy tunnel config
├── .env
├── .env.example
├── package.json
├── pnpm-workspace.yaml
└── README.md
```

### Stack

- **Frontend**: Next.js 15 (App Router), React 19, Tailwind v4, shadcn/ui, Recharts v3, Framer Motion
- **Design direction**: command-center / trading-terminal aesthetic. Dark base (`#0a0a0b`), frosted-glass panels (`backdrop-blur-xl` + 6-8% white overlay + 1px inner border), Geist Mono for all numbers, subtle gradient accents on focus/hover, per-position thesis-health glow strip (green Intact / amber Weakening / red Broken / grey Stale), live-status pulsing dot indicators (fresh/stale data), Framer Motion fade+slide on insight feed items.
- **Backend**: Next.js API route handlers (dashboard reads + chat) + standalone Node+Fastify worker (ingestion, scheduling, alert/digest pipeline)
- **DB**: Postgres 16 + pgvector in the gaming PC Docker stack; Prisma ORM
- **Jobs**: `croner` inside worker process (no Redis/BullMQ); JobRun table tracks idempotency + retries and an independent watchdog detects silent schedules
- **LLM**: `@anthropic-ai/sdk` with prompt caching + tool-use for structured outputs
- **Embeddings**: `@xenova/transformers` local `bge-small-en-v1.5` (CPU, no external API)
- **Notifications**: Telegram Bot API
- **Auth**: single password in env → hashed compare → httpOnly signed session cookie (iron-session)
- **Remote access**: Tailscale Serve terminates tailnet-only HTTPS on port 3500
- **Language**: TypeScript everywhere (strict)

### Data flow

```
┌─────────────────────┐
│    Croner (worker)  │──┐
│  7am, 4:30pm,       │  │
│  */5 min,           │  │
│  Sun 8pm            │  │
└─────────────────────┘  │
                         ▼
                ┌───────────────┐       ┌──────────────────────┐
                │  Worker       │──────▶│  Sources             │
                │  (Fastify)    │       │  alpaca, finnhub,    │
                │               │◀──────│  edgar, tiingo, fred,│
                └───────────────┘       │  stocktwits*, yahoo │
                        │               └──────────────────────┘
                        ▼
                ┌───────────────┐       ┌──────────────┐
                │  Postgres     │       │  Claude API  │
                │  (pgvector)   │──────▶│  (tiered)    │
                │  events,      │◀──────│              │
                │  articles,    │       └──────────────┘
                │  insights,    │       ┌──────────────┐
                │  theses,      │──────▶│  Embedder    │
                │  embeddings   │◀──────│  (local)     │
                └───────────────┘       └──────────────┘
                        │
                        ├─────────────────────┐
                        ▼                     ▼
                ┌───────────────┐    ┌──────────────┐
                │  Next.js web  │    │  Telegram    │
                │  (dashboard)  │    │  (alerts,    │
                └───────────────┘    │   digests)   │
                        ▲            └──────────────┘
                        │
              Tailscale Serve (tailnet HTTPS)
```

### Data model (Prisma)

```prisma
model UserSettings {
  id                        Int      @id @default(1)
  passwordHash              String
  monthlyBudget             Decimal  @default(0)
  singlePositionCapPct      Float    @default(15)
  sectorCapPct              Float    @default(40)
  intradayMoveThresholdPct  Float    @default(5)
  passCooldownDays          Int      @default(14)
  perTickerDailyAlertCap    Int      @default(3)
  telegramChatId            String?
  dailySpendCapUsd          Decimal  @default(2.0)
  monthlySpendCapUsd        Decimal  @default(10.0)
  killSwitch                Boolean  @default(false)
  timezone                  String   @default("America/Toronto")
  updatedAt                 DateTime @updatedAt
}

model Position {
  id          Int       @id @default(autoincrement())
  ticker      String    @unique
  shares      Decimal
  avgCost     Decimal
  category    String    // Conviction | Speculative | Meme | Income | Other
  sector      String?
  openedAt    DateTime  @default(now())
  closedAt    DateTime?
  notes       String?
  thesis      Thesis?
  updatedAt   DateTime  @updatedAt
}

model Thesis {
  id                Int                 @id @default(autoincrement())
  positionId        Int                 @unique
  position          Position            @relation(fields: [positionId], references: [id])
  summary           String
  pillars           Json                // [{ statement, status, lastEvaluatedAt, evidence }]
  riskFactors       Json                // [{ statement, triggered, evidence }]
  status            ThesisStatus        @default(Intact)
  createdAt         DateTime            @default(now())
  lastValidatedAt   DateTime            @default(now())
  evaluations       ThesisEvaluation[]
}

enum ThesisStatus { Intact Strengthening Weakening Broken }

model ThesisEvaluation {
  id          Int          @id @default(autoincrement())
  thesisId    Int
  thesis      Thesis       @relation(fields: [thesisId], references: [id])
  prevStatus  ThesisStatus
  newStatus   ThesisStatus
  rationale   String
  citations   Json         // [{ articleId, quote }]
  createdAt   DateTime     @default(now())
  embedding   Unsupported("vector(384)")?  // bge-small dim
}

model Watchlist {
  id         Int      @id @default(autoincrement())
  ticker     String   @unique
  addedAt    DateTime @default(now())
  reason     String?
  addedBy    String   // "user" | "agent"
}

model Article {
  id             Int       @id @default(autoincrement())
  sourceTier     Int       // 1 | 2 | 3
  source         String    // finnhub | edgar | reddit | stocktwits | …
  domain         String?
  url            String    @unique
  headline       String
  body           String?
  publishedAt    DateTime
  tickers        String[]
  clusterId      String?
  trustedCitable Boolean   @default(true)
  satireBlocked  Boolean   @default(false)
  fetchedAt      DateTime  @default(now())
  embedding      Unsupported("vector(384)")?
  @@index([publishedAt])
  @@index([tickers])
}

model MarketEvent {
  id          Int        @id @default(autoincrement())
  kind        EventKind
  ticker      String?
  payload     Json
  occurredAt  DateTime
  processedAt DateTime?
  createdAt   DateTime   @default(now())
}

enum EventKind { Earnings Filing8K BreakingNews IntradayMove SectorNews Macro SentimentSpike }

model Insight {
  id              Int            @id @default(autoincrement())
  kind            InsightKind
  title           String
  body            String
  reasoning       String
  citations       Json
  actionJson      Json?          // { type, ticker, shares, targetTicker?, priceSnapshot }
  confidence      Confidence
  status          InsightStatus  @default(New)
  userFeedback    UserFeedback?
  triggeredBy     String         // digest:morning | digest:evening | event:<kind> | monthly | weekly
  clusterId       String?
  createdAt       DateTime       @default(now())
  resolvedAt      DateTime?
  @@index([createdAt])
  @@index([status])
}

enum InsightKind { ThesisUpdate Rebalance BuySuggestion Alert }
enum Confidence { Low Medium High }
enum InsightStatus { New Seen Bought Passed Snoozed }
enum UserFeedback { Bought Passed Snoozed }

model PassCooldown {
  id         Int      @id @default(autoincrement())
  ticker     String
  actionKind String   // "buy" | "trim" | "rotate"
  until      DateTime
  insightId  Int?
  @@unique([ticker, actionKind])
  @@index([until])
}

model ChatMessage {
  id         Int      @id @default(autoincrement())
  role       String   // user | assistant
  content    String
  citations  Json?
  createdAt  DateTime @default(now())
}

model LlmCall {
  id             Int      @id @default(autoincrement())
  model          String
  inputTokens    Int
  outputTokens   Int
  cachedTokens   Int      @default(0)
  costUsd        Decimal
  purpose        String
  createdAt      DateTime @default(now())
  @@index([createdAt])
}

model JobRun {
  id         Int       @id @default(autoincrement())
  name       String
  status     String    // queued | running | succeeded | failed
  error      String?
  startedAt  DateTime  @default(now())
  endedAt    DateTime?
  metadata   Json?
  @@index([name, startedAt])
}

model BacktestRun {
  id         Int       @id @default(autoincrement())
  startDate  DateTime
  endDate    DateTime
  config     Json      // { caps, monthlyBudget, rules }
  result     Json      // { entries, exits, finalValue, returnPct, spyReturnPct, drawdownPct }
  createdAt  DateTime  @default(now())
}
```

### Source adapters

Each adapter exports:

```ts
interface SourceAdapter<T> {
  name: string;
  tier: 1 | 2 | 3;
  fetch(params): Promise<T[]>;
  rateLimit: { perMinute: number; perDay?: number };
}
```

Shared token-bucket rate limiter in `packages/sources/rate-limit.ts`.

**Adapters**:

- **alpaca** — REST quote/bars + WebSocket stream for intraday prices (paper-account key, IEX-only feed is fine for our names)
- **finnhub** — REST `/company-news`, `/calendar/earnings`, `/stock/profile2`, `/quote`, `/stock/recommendation`, `/stock/insider-transactions` (never WebSocket — their news socket is broken)
- **edgar** — RSS poll per CIK for 8-K/10-Q/10-K; user-agent header `vantage raghav@frameworth.com` is mandatory
- **tiingo** — US symbol-universe seed, bounded daily-history fallback, and backtest history
- **fred** — DGS10, FEDFUNDS, UNRATE, CPIAUCSL, VIXCLS series; polled daily
- **stocktwits** — optional tier-3 stream, disabled by default because anonymous v2 access is retired; enabled only for installations with approved API access
- **twelvedata** — public Canadian symbol-universe refresh only; it is not a live quote fallback
- **yfinance** — pinned `yahoo-finance2`; primary Canadian quote/history/profile/fundamentals path and last-resort US quote fallback

Each adapter writes normalized rows to Postgres. Articles (news/optional StockTwits/EDGAR headlines) → `Article`. Structured events (earnings releases, filings, price moves, sentiment spikes) → `MarketEvent`. Prices → time-series cache keyed by `(ticker, timestamp)`.

### LLM strategy

**Model tiering**:

- **Haiku 4.5** — per-article relevance filter + satire sanity check. Input: article headline + body snippet + held/watchlist ticker list. Output: `{ matches_tickers: string[], likely_satire: bool }`.
- **Sonnet 4.6** — digests (morning/evening/monthly), event alerts, thesis evaluations, rebalance suggestions, chat responses.
- **Opus 4.7** — weekly Sunday deep dive only (cross-position synthesis, diversification audit, stale-thesis review).

**Keyword pre-filter (runs BEFORE Haiku)**: for each article, check if body contains any held/watchlist ticker symbol or canonical company name. If no match, discard without LLM call. This is the single biggest cost lever.

**Prompt caching**:

- Static system prompt (agent persona, rules, output format) — cache
- Portfolio state + thesis pillars — cache (5-min TTL, invalidate on any CRUD change)
- Recent relevant news window — NOT cached

**Structured outputs via tool-use**:

- `emit_thesis_update(positionId, newStatus, rationale, citations[])`
- `emit_rebalance_suggestion(action, ticker, shares, targetTicker?, reasoning, citations[], confidence)`
- `emit_buy_suggestion(ticker, shares, reasoning, citations[], confidence)` — must respect caps
- `emit_alert(kind, title, body, reasoning, citations[])`
- Every tool call requires a non-empty `citations[]` or the engine strips it.

**Cost control**:

- Per-call logging → `LlmCall` table
- Before each call: check today's/month's spend vs caps; if exceeded, flip `killSwitch` and notify via Telegram
- Per-ticker daily alert cap (3/day default) enforced before Sonnet call
- Cache hit rate surfaced on `/ops` page
- Expected steady-state cost: **~$10-15/mo** (Haiku filter ~$4, Sonnet digests ~$5, Sonnet alerts ~$3, Opus weekly ~$3, monthly allocation ~$0.50)

### Chat RAG (pgvector)

On every write to `Article` and `ThesisEvaluation`, the worker embeds the content with local `bge-small-en-v1.5` (384-dim) and stores in the `embedding` column. The `ChatMessage` flow:

1. User message → embed → pgvector cosine search top-20 over `Article` + `ThesisEvaluation`
2. Filter results to tickers referenced in question or currently held
3. Build context: { retrieved docs (trimmed), current portfolio snapshot, recent thesis statuses }
4. Sonnet call with tool-use option to fetch more context if needed
5. Response written to `ChatMessage` with citation list

### Scheduling

`croner` runs inside the worker with `America/Toronto` as the default timezone.
The executable source of truth is `CRON_SPECS` in `apps/worker/src/cron.ts`; the
complete operator-facing schedule is kept in the README's "What runs
automatically" table. Keeping one table avoids the old ten-job snapshot drifting
from the 23 registered schedules.

Each job is idempotent keyed on `JobRun (name, startOfPeriod)`.

### Source-tier + dedup rules

- Incoming articles classified by domain → tier 1/2/3
- Archived social articles and approved StockTwits data are forced to tier 3 regardless of post score
- Satire blocklist: `babylonbee.com`, `theonion.com`, `clickhole.com`, `reductress.com`, extensible
- Dedup cluster key: `sha1(normalize(headline[:120]) + roundTime(publishedAt, 6h) + primaryTicker)`
- Alert-level dedup: if an Insight with same `clusterId` sent in last 6h, suppress
- Strong claims (thesis Intact→Broken, or buy suggestions >10% of monthly budget) require ≥1 tier-1 citation or confidence is downgraded to Low

### Cold-start / bootstrap

First-run audit per ticker (`POST /jobs/bootstrap/:ticker`):

1. Pull last 30 days news, last 4 earnings, last 2 quarters of 10-K/10-Q/8-K
2. Embed all pulled articles into pgvector
3. Sonnet synthesizes: "Stated thesis vs. what I see → gaps, concerns, strengths"
4. Writes initial `ThesisEvaluation` + updates `Thesis.lastValidatedAt`

### Bought / Passed flow

When an Insight has `actionJson` (buy/trim/rotate suggestion):

- **Bought** button → navigates to the Position form with `ticker`, `shares`, `priceSnapshot` pre-filled as `avgCost` candidate; user confirms/edits then saves. Insight.status = Bought, UserFeedback = Bought.
- **Passed** button → Insight.status = Passed, UserFeedback = Passed. Insert/update `PassCooldown(ticker, actionKind, until = now + passCooldownDays)`. Rebalance/buy engines check `PassCooldown` before proposing the same action again.

### Wealthsimple CSV import

- Dedicated "Bulk Import" page with a textarea
- Accepts paste format: `ticker,shares,avg_cost,category` (one per line, header optional)
- Parses, previews as a table with validation (ticker exists on Finnhub, shares > 0, category in enum)
- User confirms → upsert `Position` rows
- Missing positions (in DB but not in paste) flagged, not auto-closed

### Backtest harness

- `packages/core/backtest.ts`
- Input: `{ startDate, endDate, monthlyBudget, caps, strategy: 'monthly-allocation' | 'rebalance-only' }`
- Uses Tiingo daily bars as price oracle
- Replays: at each month-start date, compute caps against as-of portfolio, call Sonnet's `emit_buy_suggestion` logic (or a deterministic variant for reproducibility), record trades
- Output: `BacktestRun.result` with entry/exit points, cumulative return, SPY benchmark return, max drawdown
- Accessible from `/backtest` page with form + result chart (Recharts)

### Auth

- Single password set in `.env` as `ADMIN_PASSWORD_HASH` (bcrypt hash of plaintext password)
- Login form → compare → iron-session signed httpOnly cookie, 7-day TTL
- All dashboard routes middleware-gated
- Worker HTTP endpoints gated by `WORKER_SECRET` header (shared with web app)

### Deployment

**Dev environment (laptop)**:

- `pnpm dev` runs web (port 3000) + worker (port 3001) against the configured database
- Runtime environment lives in the repository-root `.env`
- Docker is not run on the laptop; container work always targets the `gamingpc` context

**Prod environment (gaming PC, Windows 11 + Docker Desktop)**:

- `infra/docker-compose.yml` runs Postgres 16 + pgvector, web, and worker
- Every Docker command uses the explicit `gamingpc` context from the Linux workspace
- Tailscale Serve terminates HTTPS on port 3500 and proxies to loopback-only web port 3000
- Postgres and worker ports are loopback-only; database backups are taken before migrations

### Security / operational

- `.env` never committed (`.gitignore` enforced)
- `WORKER_SECRET` rotates on deploy; web → worker calls include it as `x-worker-secret` header
- Telegram bot token + chat_id validated on first send
- Tailscale Serve provides tailnet-only TLS access; no public inbound port is opened
- Logging is structured JSON on Docker stdout with secrets redacted
- Durable Telegram outbox plus self-alerts for every failed job, missed schedule, or spend-cap breach

## Tasks

> Historical implementation checklist. It records the original build plan and
> is not a release-status dashboard. Use the executable code, Prisma migrations,
> `README.md`, and the dated audit plans under `docs/plans/` for current state.

### Phase 1 — Repo + infra skeleton

- [ ] Init pnpm workspace, TS strict config, ESLint + Prettier
- [ ] Scaffold `apps/web` (Next.js 15 + Tailwind v4 + shadcn init)
- [x] Scaffold `apps/worker` (Fastify + Croner)
- [ ] Scaffold `packages/db` (Prisma + initial schema + pgvector migration)
- [ ] Scaffold `packages/core`, `packages/sources`, `packages/llm`, `packages/embed`, `packages/notify` (empty exports)
- [ ] Write `.env.example` with all required vars
- [ ] `infra/docker-compose.yml` with Postgres 16 + pgvector image
- [ ] `infra/deploy-to-pc.sh` scaffold
- [ ] `infra/cloudflared/config.yml` scaffold

### Phase 2 — Data layer

- [ ] Write Prisma schema (models above), run migration against local Docker Postgres
- [ ] Add pgvector extension migration + vector columns
- [ ] Seed script for `UserSettings` defaults (prompts for admin password, bcrypts it)
- [ ] CRUD helper functions in `packages/db` for Position, Thesis, Watchlist, Insight, Article, MarketEvent, PassCooldown

### Phase 3 — Source adapters

- [ ] Shared token-bucket rate limiter
- [ ] Alpaca adapter: REST quotes + bars + WebSocket stream
- [ ] Finnhub adapter: news, earnings calendar, profile, quote, recommendations, insider transactions (REST only)
- [ ] EDGAR adapter: CIK lookup + RSS poll with UA header
- [ ] Tiingo adapter: US symbol universe, bounded history fallback, and backtest history
- [ ] FRED adapter: macro series
- [x] Reddit adapter retired: credentials and runtime collection removed
- [x] StockTwits adapter circuit-breaks and stays disabled without approved access
- [ ] yahoo-finance2 adapter (pinned version; primary Canadian quote/history/fundamentals path)
- [ ] Source-tier classifier + satire blocklist
- [ ] Dedup cluster-key hasher

### Phase 4 — Embedding layer

- [ ] `packages/embed`: wrap `@xenova/transformers` with `bge-small-en-v1.5`
- [ ] Embed-on-write hook for Article + ThesisEvaluation
- [ ] pgvector similarity-search helper

### Phase 5 — LLM layer

- [ ] Anthropic client wrapper with prompt caching helpers
- [ ] Model tier selector `pickModel(task)`
- [ ] Structured-output tool definitions
- [ ] Citation-stripper: drop claims lacking citations
- [ ] Spend tracker: wrap every call, write `LlmCall`, enforce caps, kill switch
- [ ] Per-ticker alert cap enforcement
- [ ] Prompt builders: `buildPortfolioContext()`, `buildThesisContext()`, `buildArticleWindow(hours)`
- [ ] Keyword pre-filter utility

### Phase 6 — Ingestion + event detection

- [ ] Worker endpoint `POST /jobs/poll/news` (Finnhub + optional StockTwits)
- [ ] Worker endpoint `POST /jobs/poll/filings` (EDGAR)
- [ ] Worker endpoint `POST /jobs/poll/prices` (Alpaca intraday + threshold check)
- [ ] Worker endpoint `POST /jobs/poll/earnings` (Finnhub calendar + actuals detection)
- [ ] Worker endpoint `POST /jobs/poll/eodHistory` (Alpaca US + Yahoo Canada + Tiingo fallback)
- [ ] Worker endpoint `POST /jobs/poll/macro` (FRED)
- [ ] Haiku relevance filter (post keyword pre-filter)
- [ ] Event → MarketEvent writer + dispatch to alert pipeline

### Phase 7 — Alert pipeline

- [ ] `packages/core/alert.ts`: MarketEvent → Sonnet `emit_alert` → Insight → Telegram
- [ ] Telegram adapter in `packages/notify`: send + retry + chat_id verification
- [ ] Alert-level dedup (6h cluster window)
- [ ] Per-ticker alert cap check

### Phase 8 — Digest pipeline

- [ ] `packages/core/digest.ts`: parametrized by window
- [ ] Morning digest endpoint (overnight + premarket + earnings today + catalysts)
- [ ] Evening digest endpoint (recap + AH earnings + tomorrow calendar + thesis deltas)
- [ ] Monthly allocation digest endpoint (audit + caps + budget → buy suggestions)
- [ ] Weekly Opus deep-dive endpoint

### Phase 9 — Thesis engine

- [ ] `packages/core/thesis.ts`: evaluate Thesis against time-windowed Articles + MarketEvents → ThesisEvaluation
- [ ] Per-pillar scoring, status aggregation
- [ ] Bootstrap endpoint `POST /jobs/bootstrap/:ticker`

### Phase 10 — Rebalance engine

- [ ] `packages/core/rebalance.ts`: concentration metrics, caps enforcement
- [ ] Candidate sourcer (sector/theme adjacents + watchlist + news-surfaced)
- [ ] Suggestion generator with Sonnet + cap-aware + PassCooldown-aware
- [ ] Dollar-to-shares converter using latest Alpaca/Tiingo price

### Phase 11 — Backtest

- [ ] `packages/core/backtest.ts`: historical replay engine
- [ ] `/backtest` page with form + results chart
- [ ] BacktestRun persistence

### Phase 12 — Web dashboard

- [ ] Auth: login page, iron-session middleware, logout
- [ ] Layout: dark command-center aesthetic, frosted-glass panels, Geist Mono numbers, sidebar nav
- [ ] Portfolio page: holdings table + thesis-health glow strip + P&L from latest price + live-status dot
- [ ] Add/Edit position drawer (ticker, shares, avg cost, category, thesis pillars, risk factors)
- [ ] Bulk Import page (CSV paste → preview → confirm)
- [ ] Insights feed page: chronological stream, Framer Motion enter animations, Bought/Passed buttons
- [ ] Per-position thesis detail page: pillars with per-pillar status, evaluation history, linked Articles, similar-context retrieval
- [ ] Watchlist page
- [ ] Catalyst calendar page (next 14 days)
- [ ] Chat page: Claude-backed Q&A with pgvector retrieval + citations
- [ ] Settings page: budget, caps, intraday threshold, Telegram chat_id, pass cooldown, spend caps, kill switch
- [ ] Backtest page (see Phase 11)

### Phase 13 — Observability + ops

- [ ] `/ops` page: JobRun status, LlmCall spend (today / month), cache hit rate, source health
- [ ] Structured JSON logger
- [ ] Self-alert via durable Telegram delivery for every failed job, missed schedule, or spend-cap breach

### Phase 14 — Deployment

- [ ] Local dev validated end-to-end on laptop
- [ ] Postgres + pgvector installed on gaming PC
- [ ] PM2 configs + deploy script tested
- [ ] `cloudflared` tunnel set up, public URL live
- [ ] Telegram bot registered, chat_id captured, end-to-end test alert
- [ ] Bootstrap run for each current holding to populate baseline theses
- [ ] First real digest delivered

### Phase 15 — Market discovery + active rotation (implemented)

**Why**: current design only sees news about tickers the user already holds or watchlists, so "discovery" is limited to names that bubble up from existing coverage. True alpha requires the bot to scan the broader market for catalysts it wasn't looking for, then actively propose rotations out of weakening positions into better-positioned names — not only when caps are violated.

**Scope**:

- Broader market news ingestion (not scoped to held/watchlist tickers)
- Automated ticker extraction from general news
- Discovery engine: rank every ticker in the universe by catalyst strength signals
- Rotation engine: score held positions against top-N discovered candidates, propose rotations when a candidate dominates a held position
- Weekly discovery digest: "what the market did this week that you don't own"
- Unsolicited rotation suggestions in daily digests (not only cap-triggered)

**Tasks**:

- [x] **Market-wide news poller** — `apps/worker/src/jobs/pollMarketNews.ts`
  - `POST /jobs/poll/marketNews`, `*/15 * * * 1-5` cron
  - Pulls Finnhub `/news?category=general` (broad market) + per-sector feeds (technology, energy, healthcare, financial)
  - Writes Article rows with empty `tickers[]` initially; the extraction step below fills them in
  - Rate-limited, dedup by URL, classify tier, satire-filtered

- [x] **Ticker extraction** — `packages/llm/src/ticker-extract.ts`
  - Two-pass extraction:
    1. **Regex + alias dictionary** (cheap, runs on every article) — match `\$[A-Z]{1,5}\b`, `\b[A-Z]{2,5}\b` against a cached universe of valid tickers (seed from Finnhub `/stock/symbol`, refresh weekly), plus company-name aliases (cached from Finnhub `/stock/profile2`)
    2. **Haiku fallback** (only if regex match count is 0 AND article is tier-1) — single Haiku call with a pinned ticker-extract tool, scoped to general-market stories
  - Writes `Article.tickers[]` with extracted set, flags `Article.trustedCitable` based on tier

- [x] **Ticker universe cache** — `packages/db/src/tickerUniverse.ts`
  - New table `TickerUniverse { symbol PK, name, exchange, sector, aliases[], lastRefreshed }`
  - Weekly refresh job `poll.tickerUniverse` (Sunday 6am) pulls Finnhub `/stock/symbol?exchange=US`
  - Used by ticker-extract regex matcher and discovery scorer

- [x] **Discovery signals** — `packages/core/src/discover/signals.ts`
  - For every ticker with recent activity (last 30d), compute:
    - `newsVolumeScore`: count of articles × (tier-weighted: tier-1=3, tier-2=2, tier-3=1), log-scaled
    - `earningsSurpriseScore`: abs(actual − estimate) / estimate for reported earnings in last 30d; sign-aware (beats positive, misses negative)
    - `insiderBuyScore`: net USD value of Form-4 insider buys in last 90d (from Finnhub `/stock/insider-transactions`)
    - `filingVelocityScore`: 8-K frequency in last 30d
    - `priceMomentumScore`: 20-day return vs sector avg
    - `sentimentScore`: optional approved StockTwits volume + sentiment polarity (light weight, capped contribution)
  - Composite `discoveryScore` = weighted sum on the signals' native scale (negative values allowed; healthy complete rows are typically around 0-10); weights are tunable in settings
  - Pure functions, DB-backed reads, no LLM

- [x] **Discovery table** — new Prisma model `DiscoveryScore { ticker, score, signalBreakdown JSON, computedAt, @@index([computedAt, score desc]) }`
  - Recomputed nightly at 6pm ET via `POST /jobs/discover/compute`
  - Keeps 30d of history for trend analysis

- [x] **Rotation scorer** — `packages/core/src/discover/rotation.ts`
  - For each held Position: compute a "position health" score from its Thesis.status (Broken=-1, Weakening=-0.3, Intact=0, Strengthening=0.5) + recent price performance
  - For each top-20 DiscoveryScore unheld ticker: if `discoveryScore(candidate) − health(held) > threshold (default 0.6)` AND the held position's thesis is Weakening or Broken → emit rotation candidate `{ trimTicker, buyTicker, rationale, scoreDelta }`
  - Caps-aware: proposed buy must fit within singlePositionCapPct post-purchase
  - PassCooldown-aware for both trim and buy sides

- [x] **Rotation tool definition** — extend `packages/llm/src/tools.ts`
  - New tool `emit_rotation_suggestion({ trimTicker, trimShares, buyTicker, buyShares, scoreDelta, reasoning, citations[] })`
  - Separate from `emit_rebalance_suggestion` (which is cap-driven) to let the LLM articulate the "X is weaker, Y is stronger" argument cleanly

- [x] **Discovery digest** — `packages/core/src/digests/discovery.ts`
  - Weekly, Saturday 10am ET
  - Content: top 10 DiscoveryScores not in portfolio/watchlist, top 5 rotation candidates, sector-level heatmap (which sectors gained narrative strength this week)
  - Sonnet call with `emit_buy_suggestion` + `emit_rotation_suggestion`
  - Telegram digest + Insight rows
  - Cron: `0 10 * * 6`

- [x] **Daily digest integration** — update `packages/core/src/digests/{morning,evening}.ts`
  - After the existing body: if any rotation candidates pass threshold, append rotation suggestions
  - Separate from cap-driven rebalance insights (different kind, different icon)

- [x] **Monthly allocation update** — update `packages/core/src/digests/monthly.ts`
  - Replace "top 5 most-mentioned unheld" candidate bucket with top-N DiscoveryScores (default N=10)
  - Watchlist still included as a secondary bucket (user-flagged names explicitly)
  - Cooldown + cap checks unchanged

- [x] **Dashboard — Discovery page** — `apps/web/src/app/(dashboard)/discovery/page.tsx`
  - Table: top 50 tickers by discoveryScore, with signal breakdown (hover tooltip), last computed time
  - Filter by sector, held/unheld, score threshold
  - Row action: "Add to watchlist" / "Bootstrap" / "See news"
  - Live-status dot on stale scores (>24h)

- [x] **Insights feed** — add rotation card variant with dual-ticker layout (trim side + buy side) and unified Bought/Passed flow:
  - Bought on a rotation → opens Position form for the BUY side pre-filled, plus a follow-up prompt to trim the sell side
  - Passed → cooldowns BOTH the trim and the buy actions for passCooldownDays

- [x] **Settings** — expose discovery weights JSON editor + recompute-now button
  - `discoveryWeights: { news, earnings, insider, filings, momentum, sentiment }`

- [x] **Smoke tests**:
  - `pollMarketNews` fetches and writes Articles with extracted tickers
  - `signals.ts` unit tests with fixtures for each signal
  - `rotation.ts` correctly flags a rotation when candidate beats held by threshold
  - Discovery digest produces insights with mixed buy + rotation suggestions
  - `/discovery` page renders with live data

**Edge cases specific to Phase 15**:

- **Ticker extraction false positives**: regex matching 2-5 letter uppercase words catches English acronyms. Mitigation: ticker universe lookup required, not just regex match; tier-3 articles get extracted tickers flagged with lower confidence in DiscoveryScore.
- **Microcap noise**: restrict discovery universe to tickers with ≥$500M market cap to avoid penny-stock pumps dominating the signal. Pull market cap from Finnhub profile, cache, refresh weekly.
- **Sector adjacency bias**: the LLM will favor rotation within the same sector. Prompt must explicitly allow cross-sector rotations when DiscoveryScore delta is large.
- **Paid signal gap**: no Finnhub free access to analyst consensus changes, short interest, options flow. Paid upgrade path documented but not in scope.
- **Cost**: broader news ingestion means more Haiku relevance filter calls. Keyword pre-filter catches most; budget with per-article-cost telemetry. Hard cap rotation digests to 1 Sonnet call per day.

### Phase 16 — Multi-exchange coverage (TSX + NEO) (implemented)

**Why**: Raghav is a Canadian retail investor on Wealthsimple; his deployable capital goes into both US and TSX listings (banks, Shopify, CNR, Enbridge, BAM). US-only coverage misses half the universe he actually buys. NEO (Cboe Canada) is lower priority but worth including for ETFs and smaller Canadian listings.

**Scope**:

- TickerUniverse seeded with TSX + NEO symbols in addition to US
- Price oracle routes by exchange: Alpaca/Finnhub for US, yahoo-finance2 first for TSX/NEO/TSX-V, then stored history fallbacks
- News ingestion pulls Finnhub company news for Canadian tickers (Finnhub supports them natively)
- Currency awareness: Canadian positions tracked in CAD, reporting converts to portfolio base currency via FRED USD/CAD cross-rate
- Sector classification normalized across exchanges (Finnhub returns mostly consistent sector labels, but filtering needs a shared taxonomy)

**Tasks**:

- [x] **TickerUniverse schema** — add columns:

  ```prisma
  currency   String   @default("USD")  // USD | CAD
  exchange   String                     // already exists; enforce values: US, TO, NE, V
  symbolRaw  String?                    // original symbol without suffix (e.g. "SHOP" for "SHOP.TO")
  ```

  Migration + backfill existing rows to `currency=USD`, `exchange=US`.

- [x] **Multi-exchange universe adapters** — Tiingo supplies US listings and Twelve Data supplies TO/NE/V; `pollTickerUniverse` iterates `UserSettings.exchangesEnabled` (default `['US', 'TO']`).

- [x] **Symbol normalization** — `packages/sources/src/symbols.ts`:
  - `normalizeSymbol(raw: string, exchange: string): { symbol: string, suffix: string }` — "SHOP.TO" → { symbol: 'SHOP.TO', suffix: '.TO' }; "AAPL" → { symbol: 'AAPL', suffix: '' }
  - `deriveCurrency(exchange): 'USD' | 'CAD'` — US→USD; TO/NE/V→CAD
  - Used at write time in pollTickerUniverse + article ticker extraction

- [x] **Exchange-aware price oracle** — update `packages/core/src/rebalance/priceOracle.ts`:
  - Lookup ticker in TickerUniverse to get exchange
  - US → Alpaca (primary) → Finnhub → yfinance
  - TO/NE/V → yfinance (primary) → Finnhub/Tiingo fallbacks — Alpaca cannot serve Canadian quotes
  - Returns `{ price, currency, source, asOf }` — currency now part of the payload

- [x] **Currency conversion** — `packages/core/src/fx.ts`:
  - `getUsdCadRate(asOf: Date): Promise<number>` — pull FRED series `DEXCAUS` (CAD per USD) with ~daily resolution
  - `convertToUsd(amount: number, currency: 'USD' | 'CAD', asOf: Date): Promise<number>`
  - Cache rate for 1 hour in-process
  - Dashboard displays are single-currency (USD as base) with original-currency annotation on Canadian positions

- [x] **Portfolio valuation update** — concentration + cap metrics compute in USD across mixed-currency positions. Position rows store `avgCost` in position's native currency; `computeConcentration()` converts to USD via fx helper.

- [x] **Ticker extraction** — `packages/llm/src/ticker-extract.ts`:
  - Regex: cashtag form handles `.TO`/`.NE` suffixes (`\$([A-Z]{1,5}(?:\.(?:TO|NE|V))?)\b`)
  - Plain-letter form stays, but alias dictionary needs Canadian company names (Shopify, Royal Bank, TD, etc.) cached from TSX profiles
  - Prefer Canadian ticker when an alias matches a Canadian-listed name in a Canadian news source; prefer US ticker in US context (hard; default to both and let the LLM filter)

- [x] **News ingestion** — `poll.news` + `poll.marketNews` pull company news for TSX tickers where Finnhub supports it. Approved StockTwits coverage is optional, thin for Canada, and always tier-3.

- [x] **EDGAR scope** — EDGAR remains US-only. For TSX-listed names that also file in US (Shopify, Canadian Pacific, etc.), their US filings still surface. Canadian-only filings from SEDAR are not in scope for Phase 16 (SEDAR has no clean free API; defer).

- [x] **FRED series** — add `DEXCAUS` (CAD per USD) and `IRSTCI01CAM156N` (Canadian call-money-rate proxy) to `pollMacro` so Canadian rate-sensitive theses have signal.

- [x] **Dashboard updates**:
  - Portfolio page: exchange badge on each position row (🇺🇸 / 🇨🇦), original-currency + USD-converted value side-by-side
  - Settings: "Exchanges enabled" multi-select (US, TSX, NEO, TSX-V)
  - Discovery page: filter by exchange
  - Chat: responses aware of both currencies

- [x] **Wealthsimple-specific guidance in docs**: trades are commission-free, but CAD/USD conversion can still carry an FX fee. Prefer a suitable TSX-native listing when it avoids unnecessary conversion without changing the exposure; a funded USD account avoids per-trade conversion on US securities.

- [x] **Smoke tests**:
  - TickerUniverse seeded with at least 50 TSX symbols (`SHOP.TO`, `RY.TO`, `TD.TO`, `ENB.TO`, `CNR.TO`, etc.)
  - Price oracle returns CAD price + currency tag for `SHOP.TO`
  - fx.convertToUsd smoke with live DEXCAUS
  - Portfolio with 1 US + 1 CAD position: concentration math in USD matches hand-calc

**Edge cases**:

- **Ticker collisions**: `TD` is TSX Toronto-Dominion AND US "Toronto Dominion Bank" ADR; same entity, different listings. Treat as distinct TickerUniverse rows, link via `aliases[]`.
- **Thin TSX liquidity**: small-cap Canadian names have wide spreads and sparse news. Discovery engine should weight `newsVolumeScore` more heavily for TSX (low volume → low signal), so microcap TSX names don't dominate ranking.
- **Weekend FX staleness**: DEXCAUS updates on business days only; cache handles weekend lookups by returning Friday's rate.
- **Wealthsimple doesn't do TSX-V or NEO well**: flag TSX-V and NEO positions with a dashboard warning ("check liquidity on Wealthsimple before executing").

### Phase 17 — Catalyst-driven discovery + opportunistic buys

**Why**: scheduled monthly allocation + saturday discovery digests are too coarse. real alpha for retail comes from acting on **catalyst events** — insider cluster buys, earnings beats with positive guidance, material 8-K filings, tier-1 analyst upgrades — within a 1-5 day swing window. Research backing in `~/Documents/Projects/serena/knowledge/equity-trading-signals/catalyst-buying-evidence-2026.md`.

**Scope**:

- Continuous catalyst event detection during market hours (not just monthly cadence)
- Buy suggestions for tickers **not currently held** (true discovery, not rebalance)
- Multi-signal conjunction scoring (single signals weak, conjunction strong)
- Strict quality filters (market cap ≥ $500M, daily volume ≥ $5M, exclude meme/lottery)
- Per-day cap (max 2-3 catalyst-driven buys/day) to avoid noise + decision fatigue
- Hard tier-1 citation requirement (no LLM hallucinations slipping through)

**Out of scope**:

- Intraday scalping (HFT-dominated, not retail-actionable)
- Generic news sentiment (noise > signal at retail latency)
- Tier-3 social chatter alone (already covered by the Phase 15 evidence rules)

---

#### Tasks

##### 17.1 — Insider cluster detector

- [ ] **Schema**: add `InsiderTransaction` table — `{ id, ticker, insiderName, insiderTitle, transactionDate, transactionCode, shares, pricePerShare, valueUsd, filingDate, source, createdAt, @@unique([ticker, insiderName, transactionDate, shares]), @@index([ticker, filingDate]) }`. Migration name `phase17_catalyst_engine`.
- [ ] **Adapter extension**: `packages/sources/src/finnhub.ts` — verify `getInsiderTransactions(ticker)` returns the right shape; add normalized output `{ insiderName, insiderTitle, transactionDate, transactionCode, shares, pricePerShare, valueUsd }`.
- [ ] **Poller**: `apps/worker/src/jobs/pollInsiders.ts` — `POST /jobs/poll/insiders`, cron `*/30 9-16 * * 1-5` (every 30 min during market hours).
  - For each held + watchlist + top-100 discovery ticker, pull insider txns from last 7 days
  - Filter to transaction code `'P'` (open-market purchase) only — drop options exercises (`'M'`), grants, sells (`'S'`)
  - Upsert into InsiderTransaction by unique key
  - Return `{ tickersChecked, txnsFetched, newPurchasesDetected }`
- [ ] **Cluster detector**: `packages/core/src/discover/insiderCluster.ts`
  - `detectClusters(opts: { sinceHours: number, minInsiders: number = 3, minTotalUsd: number = 1_000_000 }): Promise<ClusterEvent[]>`
  - For each ticker with ≥1 buy in window: count distinct insiders, sum totalUsd, find timespan between first and last buy
  - Emit `ClusterEvent` if (distinctInsiders ≥ minInsiders) OR (totalUsd ≥ minTotalUsd) OR (≥3 directors specifically — weight director-level higher)
  - Tag conviction level: HIGH (3+ insiders + ≥$2M), MEDIUM (≥3 insiders OR ≥$1M), LOW (single insider ≥$500k)
- [ ] **MarketEvent emission**: detected clusters → `MarketEvent { kind: 'InsiderCluster', ticker, payload: { distinctInsiders, totalUsd, conviction, insiders[], firstBuyDate, lastBuyDate } }`. Dedup against same ticker + same first-buy-date in last 7d.
- [ ] **Unit tests**: cluster detection with fixture txns — single buy (no cluster), 3 buys same ticker (cluster), 3 buys split across tickers (no cluster), $500k single (LOW), $5M from CEO+CFO+chair (HIGH), exercises-only filtered out.

##### 17.2 — Earnings beat + guidance detector

- [ ] **Schema**: extend `MarketEvent.payload` for kind=Earnings to capture `{ actualEps, estimateEps, surprisePct, revenueActual, revenueEstimate, revenueSurprisePct, guidanceDirection: 'raise'|'hold'|'lower'|null, guidanceConfidence: number, sourceArticleIds: int[] }`.
- [ ] **Existing earnings poller** (`pollEarnings.ts`) already detects actuals — verify it captures revenue + EPS surprise pct. Extend to:
  - For each earnings event with `surprisePct >= 10`, queue a Sonnet classification call
  - Sonnet reads recent post-earnings articles (24h window) and returns `{ guidanceDirection, guidanceConfidence, materialQuotes[] }` via tool-use
  - Tool: `extract_earnings_guidance({ direction: 'raise'|'hold'|'lower'|'unknown', confidence: 'low'|'medium'|'high', materialQuotes: string[] })`
  - Strict citation requirement — drop the call if no quotes from tier-1/2 sources
- [ ] **EarningsBeatEvent**: emit MarketEvent kind=`EarningsBeat` (new EventKind) when surprisePct ≥ 10 AND guidanceDirection ≠ 'lower' AND confidence ∈ {'medium','high'}. Dedup by `ticker + reportDate`.
- [ ] **Cron tweak**: `pollEarnings` already runs `*/15 * * * 1-5`. Keep cadence; add the post-actuals classification to the same job (one Sonnet call per surprise).

##### 17.3 — Material 8-K classifier

- [ ] **EDGAR adapter extension**: when a new 8-K is detected by `pollFilings.ts`, fetch the filing's primary document text (the .htm or .txt). Cache in `Article.body` if not already populated.
- [ ] **8-K classifier**: `packages/llm/src/classifiers/eightK.ts`
  - Sonnet call with tool `classify_8k({ items: string[], category: 'contract'|'mna'|'fda_regulatory'|'officer_change'|'reg_fd'|'other', materialityScore: 1-10, summary: string, marketDirection: 'bullish'|'bearish'|'neutral' })`
  - Reads the filing text + any tier-1 news article in same 24h window
  - Strict citation: filing URL must be cited; ≥1 tier-1 news citation required for materialityScore ≥ 7
- [ ] **Material8KEvent**: emit MarketEvent kind=`Material8K` (new EventKind) when materialityScore ≥ 7 AND marketDirection != 'bearish'. Dedup by `ticker + filingDate + category`.
- [ ] **Cost gate**: max 5 8-K classifications/day across all tickers. Skip if cap hit (8-Ks at edge of materiality can wait for morning digest).

##### 17.4 — Analyst upgrade detector

- [ ] **Adapter**: `packages/sources/src/finnhub.ts` — `getRecommendationTrends(ticker)` already exists. Verify it returns trend deltas (consensus over time).
- [ ] **Schema**: add `AnalystRecommendation` table — `{ id, ticker, period (YYYY-MM-01), strongBuy, buy, hold, sell, strongSell, fetchedAt, @@unique([ticker, period]), @@index([ticker]) }`.
- [ ] **Poller**: `apps/worker/src/jobs/pollAnalysts.ts` — `POST /jobs/poll/analysts`, cron `0 7 * * 1-5` (once per day pre-market).
  - For each ticker in held + watchlist + top-100 discovery: fetch trend, upsert.
- [ ] **Upgrade detector**: `packages/core/src/discover/analystUpgrades.ts`
  - Compare current period vs previous period
  - Detect: `strongBuy + buy` increased by ≥2 (single tier-1 firm shift) OR consensus moved up a level (e.g. from "Hold" majority → "Buy" majority)
  - Tier-1 firms list: hardcoded lookup of recognized firms (Goldman, Morgan Stanley, JPM, Citi, BofA, Wells Fargo, Barclays, etc.) — Finnhub's free trends don't break out by firm name; use the aggregate shift as signal proxy
  - Emit MarketEvent kind=`AnalystUpgrade` with payload `{ deltaStrongBuy, deltaBuy, fromConsensus, toConsensus }`. Dedup by `ticker + month`.

##### 17.5 — Catalyst-driven buy engine

- [ ] **New module**: `packages/core/src/catalyst/engine.ts`
  - `evaluateCatalysts(opts?: { sinceHours: number = 24 }): Promise<CatalystSuggestion[]>`
  - Steps:
    1. Pull unprocessed MarketEvents of kinds: `InsiderCluster | EarningsBeat | Material8K | AnalystUpgrade` from last 24h
    2. For each event's ticker, gather **conjunction signals**:
       - Is there a co-occurring insider cluster?
       - Is there a co-occurring earnings beat?
       - Is there a tier-1 news article corroborating?
       - Is the discovery score for this ticker positive?
    3. Compute conviction score: single signal = 1, conjunction (≥2 signals same ticker in 7d window) = 2, full triplet (insider + earnings + 8-K) = 3
    4. Apply quality gates (see 17.6)
    5. Apply caps (single-position cap, sector cap, post-purchase concentration)
    6. Apply PassCooldown (skip tickers user passed in last 14d)
    7. Apply per-day cap (max 2-3 buy suggestions/day, configurable in UserSettings)
    8. Sonnet call: `emit_buy_suggestion(ticker, shares, reasoning, citations[], confidence, catalystKind, conjunctionLevel)` — extends the existing tool with `catalystKind` + `conjunctionLevel` fields
    9. Citation-stripper validates ≥1 tier-1 citation
    10. Write Insight kind=BuySuggestion with `triggeredBy: 'catalyst:<eventKind>'`, `actionJson.catalystKind`, `actionJson.conjunctionLevel`, `actionJson.urgencyHours: 48` (signals 2-day swing window)

- [ ] **Cron**: `apps/worker/src/jobs/runCatalystEngine.ts` — `0 */1 9-16 * * 1-5` (every hour during market hours). Direct cron registration in `apps/worker/src/cron.ts`.
- [ ] **Endpoint**: `POST /jobs/catalyst/run` — manual trigger, behind `x-worker-secret` + `runJob`.

##### 17.6 — Quality gates (shared, used by catalyst engine + all discovery)

- [ ] **New module**: `packages/core/src/qualityGates.ts`
  - `qualityFilter(ticker: string): Promise<{ passes: boolean, reason?: string }>`
  - Checks (all must pass):
    - **Market cap ≥ $500M** (UserSettings.discoveryMinMcapUsd; reject if null AND no market data)
    - **Avg daily volume ≥ $5M** (computed from DailyBar last 20 trading days × close × volume; needs `volume` column already on DailyBar)
    - **Not a meme/lottery flag** — manual blocklist seed (TickerUniverse.isLottery boolean column, default false; user can flag) plus auto-detect (price <$5 AND volatility >100% annualized → auto-flag)
    - **Has tier-1 news coverage in last 30d** — reject silent-stock candidates
    - **Active listing** (TickerUniverse.lastRefreshed within 30d, not delisted)
  - Rejected reasons logged per insight as `actionJson.rejectedQualityReason` (transparency)
- [ ] **Schema**: add `TickerUniverse.isLottery: boolean @default(false)` + nightly auto-detect job that updates it based on price + volatility.
- [ ] **Settings**: add `UserSettings.catalystMaxPerDay: int @default(2)` + `catalystRequireConjunction: boolean @default(true)`.

##### 17.7 — UserSettings + Settings UI

- [ ] **Settings UI** (`apps/web/src/app/(dashboard)/settings/page.tsx`):
  - New section "Catalyst engine"
  - Toggle: "Enable catalyst-driven buy suggestions" (default ON)
  - Slider: "Max catalyst buys per day" (1-5)
  - Toggle: "Require multi-signal conjunction" (default ON; if OFF, single signals can fire — riskier)
  - Per-signal toggles: insider cluster / earnings beat / 8-K / analyst upgrade (default all ON)
- [ ] Server action: persist these to UserSettings columns.

##### 17.8 — Insights feed UI

- [ ] **Catalyst badge on BuySuggestion cards** — when `actionJson.catalystKind` present:
  - Top-right corner badge: 🔬 INSIDER CLUSTER / 📈 EARNINGS BEAT / 📋 MATERIAL 8-K / ⭐ ANALYST UPGRADE
  - Conjunction-level indicator: 1/2/3 dots filled in (3 dots = full triplet, highest conviction)
  - Urgency tag: "48h window" with countdown timer if `actionJson.urgencyHours` set and `createdAt` < urgencyHours ago
- [ ] **New filter chip on /insights**: "Catalyst" chip filters to BuySuggestions where `actionJson.catalystKind IS NOT NULL`. Sits next to existing Buy chip.
- [ ] **Sort option**: when "Catalyst" chip active, sort by conjunction level desc, then urgency-remaining asc.

##### 17.9 — Discovery page integration

- [ ] **/discovery** page — add "Catalyst" column showing the most recent catalyst event for that ticker (icon + date) if any. Hover for full event details.
- [ ] **Filter**: "Show only with active catalyst" toggle on `/discovery`.

##### 17.10 — Backtest harness extension

- [ ] **Backtest engine** (`packages/core/src/backtest/engine.ts`):
  - New strategy: `'catalyst-driven'` — replays historical insider buys + earnings beats + 8-Ks against historical prices, executes equal-weight buys at next-day open after catalyst, holds for 5/10/30 days, measures alpha vs SPY
  - Requires historical insider transactions seeded (Finnhub free tier provides last 12mo)
- [ ] **Page**: `/backtest` form gains "catalyst-driven" strategy option + holding-period dropdown (5/10/30/60 days).
- [ ] **Smoke**: run catalyst-driven backtest over last 12mo on current 5 holdings — output expected alpha + max drawdown.

##### 17.11 — Telegram digests

- [ ] **Catalyst alert**: new `formatCatalystAlertForTelegram(insight)` with conjunction badge + urgency window in the title.
- [ ] **Daily catalyst summary** (optional, cron `0 16 * * 1-5` 4pm ET): aggregate any catalyst-driven buy suggestions issued during market hours that day into a single end-of-day Telegram message with the insight links. Suppresses individual alerts during the day if user opts in (`UserSettings.catalystDigestOnly` boolean default false).

##### 17.12 — Cost controls

- [ ] **Catalyst engine spend cap**: add to `UserSettings.catalystDailySpendCapUsd: Decimal @default(1.0)`. Each catalyst engine cron tick checks the spend; if breached, skip Sonnet calls for the rest of the day, log warning.
- [ ] **Conservative caps**: 8-K classifications max 5/day, earnings guidance classifications max 10/day, catalyst-engine main runs (Sonnet) max 8/day. Total expected: ~$3-5/mo additional spend.
- [ ] **Visible on /ops page** — catalyst engine spend (today / month-to-date), tied to existing LlmCall purpose tags `catalyst-eval`, `8k-classify`, `earnings-guidance`.

##### 17.13 — Smoke + integration tests

- [ ] **Unit tests**: cluster detector (5 cases), 8-K classifier with fixture filings (3 cases: high-mat contract, low-mat reg-FD, ambiguous), analyst upgrade detector (3 cases), quality gate evaluator (5 cases).
- [ ] **Integration smoke** at `apps/worker/scripts/smoke-catalyst.ts`:
  - Pre-seed: insider cluster fixture (3 buys on TICKER_X, total $2.5M, last 5 days) + 1 tier-1 news article on TICKER_X
  - Run `evaluateCatalysts({ sinceHours: 168 })`
  - Assert: 1 BuySuggestion with `catalystKind='InsiderCluster'`, `conjunctionLevel=2` (cluster + tier-1 news), citations valid, suggestion respects caps
  - Cleanup, delete script
- [ ] **End-to-end smoke**: run the catalyst engine against real DB with last 7 days of insider activity. Validate output reasonable (≤2 suggestions, all with citations).

##### 17.14 — Documentation

- [ ] Update `docs/spec.md` Progress Log with Phase 17 added.
- [ ] Update `README.md` "what runs automatically" section to include the catalyst engine.
- [ ] Add a `docs/CATALYST_ENGINE.md` explaining each signal, conviction thresholds, and how the user can tune via /settings.

---

#### Edge cases — Phase 17 specific

- **Insider Form 4 lag**: insiders have 2 business days to file Form 4. The price has often already moved by the time we see it. Mitigation: still actionable for multi-day swing, not for intraday.
- **Earnings whisper numbers**: real "beat" is vs whisper, not consensus. We don't have whisper data on free tier. Use 10% buffer above consensus to approximate.
- **Stock split / dividend artifacts**: Tiingo data is split-adjusted but Finnhub insider txns are NOT always. Reject txns where price seems off by >20% from contemporaneous DailyBar close.
- **Foreign filer 6-K vs 8-K**: NBIS-style foreign listings file 6-K instead of 8-K. Phase 17 covers 8-K only initially; add 6-K classifier as v2 if NBIS gets material events.
- **CDR insider activity**: TSX CDRs (e.g. AAPL.TO) DON'T have separate insider filings — track underlying US ticker insiders only. Document in code comments.
- **Quality gate false negatives**: small-cap-but-quality names get rejected. Acceptable trade — we want fewer high-conviction buys, not more low-conviction ones.
- **LLM guidance hallucination**: Sonnet might claim "raised guidance" when company actually maintained. Mitigation: tool-call requires `materialQuotes[]` with verbatim text, citation-stripper validates quotes appear in the article body.
- **Per-day cap enforcement race**: two cron ticks fire concurrently each thinking they have headroom → 4 suggestions emitted. Mitigation: enforce cap inside a transaction with `SELECT ... FOR UPDATE` on the LlmCall daily count, or use a leader-election pattern via JobRun bucketing.
- **PassCooldown vs catalyst**: user passed on TICKER 10 days ago, but TICKER just had a $5M insider cluster buy. Suppress or override? Default: respect cooldown UNLESS catalyst conjunction level is 3 (full triplet) — those are rare enough to override.

## Edge Cases / Gotchas

- **Finnhub rate limit mid-digest**: ship partial, mark failed source in digest footer. Retry-on-next-cron, don't block user.
- **Finnhub WebSocket news is broken**: stick to REST polling every 5 min. Documented upstream issue, no workaround.
- **Alpaca IEX-only feed**: some lightly-traded quantum/AI names may show thin prints. Cross-check against Finnhub REST quote on any >5% move before firing an alert.
- **StockTwits noise**: approved access is tier-3 and disabled by default; never solo-cite it for strong claims. Use only alongside tier-1/2 news.
- **Satirical/junk news**: domain blocklist first, then Haiku sanity check on sensational headlines. If flagged `likely_satire`, skip.
- **Single-source strong claims**: Sonnet is instructed to downgrade confidence to Low for any claim with zero tier-1 citations. Strip buy suggestions >10% of budget lacking tier-1 support.
- **Cold start (no history)**: bootstrap fills 30d context per ticker on first run. No thesis evaluations until bootstrap completes.
- **Stale thesis**: if `lastValidatedAt > 30 days`, flag on dashboard + include in next weekly deep-dive.
- **Duplicate alerts**: dedup by cluster key + 6h window. Canonical (tier-1 preferred) article sent.
- **Thinly-traded / after-hours price spikes**: ignore intraday moves outside 9:30-16:00 ET, filter by minimum volume.
- **Claude spend runaway**: daily + monthly caps enforced at wrapper level; per-ticker 3/day alert cap prevents news-day blowouts; kill switch hard-stops all non-user-initiated LLM calls.
- **User updates portfolio mid-digest**: digests snapshot portfolio state at run start; changes mid-run picked up next run.
- **EDGAR user-agent requirement**: SEC requires descriptive UA with contact email or they IP-ban silently (returns HTML error instead of RSS). Set `vantage raghav@frameworth.com` and honor it.
- **Pass cooldown active**: rebalance/buy engines check `PassCooldown` before calling LLM; if active, skip that ticker entirely, don't waste tokens.
- **Wealthsimple reconciliation drift**: Bought flow prompts user to fill in executed trade; dashboard banner if `Position.updatedAt` is older than latest earnings report for that ticker.
- **Canadian regulatory**: personal-only. Every notification footer + dashboard footer includes "Not investment advice. Personal research tool." Do not expose to anyone else — productizing would trigger OSC portfolio-manager requirements.
- **Haiku false-negatives on relevance filter**: spot-check 5% of filtered-out articles via weekly Opus review.
- **yahoo-finance2 version drift**: pin to an exact version. If it breaks, Canadian quote/history paths degrade to stored bars or unavailable states rather than crashing a poll.
- **Gaming PC sleeps / reboots**: disable sleep in Windows power plan; Docker Desktop starts at login and Compose uses `restart: unless-stopped` so services return after reboot.
- **Tailscale reconnect**: the dashboard remains tailnet-only. If the PC or Tailscale is unreachable, deployment stops instead of falling back to laptop Docker.

## Testing

- [ ] Unit: dedup cluster-key hasher
- [ ] Unit: source-tier classifier
- [ ] Unit: cap-aware share calculator
- [ ] Unit: rate limiter token-bucket
- [ ] Unit: citation-stripper drops uncited claims
- [ ] Unit: PassCooldown check
- [ ] Unit: keyword pre-filter
- [ ] Integration: morning digest against fixture (30 articles + 3 positions) → exactly 1 Insight + 1 Telegram call stub
- [ ] Integration: 8-K filing event → Insight + Telegram + dedup suppresses duplicate within 6h
- [ ] Integration: monthly allocation with budget=$500, caps enforced, ≤3 buy suggestions with citations
- [ ] Integration: backtest of monthly-allocation strategy over last 1y produces reproducible output
- [ ] Integration: chat query "why is QBTS down today?" retrieves relevant articles via pgvector, answers with citations
- [ ] Manual: satire domain blocklist blocks a Babylon Bee fixture
- [ ] Manual: kill-switch blocks all LLM calls when tripped
- [ ] Manual: Telegram bot delivers, tap-through links open dashboard pages behind auth
- [ ] Manual: Bought flow pre-fills Position form correctly
- [ ] Manual: Passed flow creates cooldown, next allocation digest skips that ticker
- [ ] Manual: CSV paste import parses, previews, and upserts correctly

---

## Progress Log

**Status**: Phases 1-17 and all six phases of the 2026-07-16 audit implementation are deployed to the gaming PC. Final production acceptance is waiting only on the 48-hour scheduler soak and the dedicated BotFather credential.
**Current phase**: scheduler soak. Currency, scheduler/watchdog, Compare, actionable rotations, chat threads/markdown/citations, durable Telegram delivery, lottery/goal/price alerts, mixed-exchange discovery, and database failure states have all passed live acceptance.
**Last completed task (2026-07-17)**: passed all 400 tests plus typecheck, lint, dependency audit, Prisma validation, Compose validation, formatting, and the production build. Browser acceptance covered every dashboard route; a forced database outage produced styled errors without raw internals; synthetic failed-job, missed-schedule, and stop-loss probes reached the durable Telegram outbox and were cleaned up afterward. Tiingo's changed supported-ticker `endDate` semantics were repaired, and a zero-row exchange refresh now fails loudly instead of leaving US listings stale behind a successful JobRun. Deep health now distinguishes a legitimate in-flight job from a missed schedule and applies a one-hour stuck-job ceiling. The audit-soak verifier enumerates every daily Toronto cron slot in the exact deployment window and rejects missing or failed JobRuns.
**Live blockers**: `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are unset until Raghav creates the dedicated Vantage bot, so actual phone delivery is the one explicitly skipped acceptance item. The final 48-hour scheduler soak starts from the latest deployment of this exact tree.

**Phase completion checkpoints**:

- [x] Phase 1 — Repo + infra skeleton
- [x] Phase 2 — Data layer
- [x] Phase 3 — Source adapters
- [x] Phase 4 — Embedding layer
- [x] Phase 5 — LLM layer
- [x] Phase 6 — Ingestion + event detection
- [x] Phase 7 — Alert pipeline
- [x] Phase 8 — Digest pipeline
- [x] Phase 9 — Thesis engine
- [x] Phase 10 — Rebalance engine
- [x] Phase 11 — Backtest
- [x] Phase 12 — Web dashboard
- [x] Phase 13 — Observability + ops
- [x] Phase 14 — Deployment baseline
- [x] Phase 15 — Market discovery + active rotation
- [x] Phase 16 — Multi-exchange coverage (TSX + NEO)
- [x] Phase 17 — Catalyst-driven discovery + opportunistic buys
