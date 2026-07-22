# Catalyst Engine

The catalyst engine is the swing-trading discovery loop that checks for queued signals every five minutes during US market hours. It watches four categories of catalyst events on tickers Raghav does not currently hold and converts the strongest signals into 48-hour BuySuggestion insights with cap-aware sizing, tier-1 citations, and a high-priority Vantage app notification.

## Signals

The engine consumes four `MarketEvent` kinds, populated by the Phase 17A pollers and detectors:

- **InsiderCluster** — three or more insiders open-market buying the same ticker inside a seven-day window, totalling $1M+. HIGH conviction tier requires three insiders AND $2M+. Form-4 filings drive this; option exercises and grants are filtered out.
- **EarningsBeat** — surprise > 10 percent versus consensus, with Sonnet's `extract_earnings_guidance` classifier confirming the post-earnings articles describe raised or held forward guidance. Lowered guidance is dropped at the detector level.
- **Material8K** — 8-K filings classified by Sonnet (`classify_8k` tool) at materiality 7+ AND non-bearish market direction. Categories include contract / M&A / FDA / officer change / Reg-FD / other; only the materiality-and-direction gate matters for the engine.
- **AnalystUpgrade** — month-over-month consensus shift in Finnhub's recommendation trends: strongBuy + buy delta of 2+, or a tier flip from "Hold majority" to "Buy majority".

## Conjunction levels

The engine groups all catalyst events by ticker over the lookback window (default 24 hours) and computes a conjunction level:

- **Level 1** — single-signal candidate (one ticker with one catalyst kind in the window).
- **Level 2** — at least two distinct event kinds for the same ticker, OR a single catalyst plus tier-1 corroborating news in the same 24-hour window.
- **Level 3** — full triplet: at least one of each of InsiderCluster, EarningsBeat, and Material8K (AnalystUpgrade is treated as auxiliary). This is rare enough to override an active PassCooldown.

Level 3 is the only path that ignores the user's "already passed on this ticker recently" cooldown.

## How the engine runs

1. Pull unprocessed catalyst MarketEvents over the last `sinceHours` window (default 24).
2. Group by ticker, rank by conjunction level descending so the strongest candidate clears the per-day cap first.
3. For each ticker, run the shared `qualityFilter`:
   - Market cap ≥ `UserSettings.discoveryMinMcapUsd` (default $500M).
   - 20-day average dollar volume ≥ $5M.
   - Not flagged as meme/lottery (auto-detect: price < $5 AND realized vol > 100 percent annualized).
   - Has at least one tier-1 article in the last 30 days.
   - Active listing — `TickerUniverse.lastRefreshed` within 30 days.
4. Apply `PassCooldown` for actionKind `buy`. Skip unless conjunction level is 3.
5. Apply per-day cap (`UserSettings.catalystMaxPerDay`, default 2) by counting today's BuySuggestion insights with `triggeredBy LIKE 'catalyst:%'`.
6. Apply daily Sonnet spend cap (`UserSettings.catalystDailySpendCapUsd`, default $1.00) by summing today's `LlmCall.costUsd` where purpose ∈ {catalyst-eval, 8k-classify, earnings-guidance}.
7. Honour `UserSettings.catalystRequireConjunction` — when ON (default), level-1 candidates are dropped before the LLM is touched.
8. Build a Sonnet prompt: catalyst event payloads, recent tier-1/2 articles (24h window), portfolio snapshot, caps. Call `purpose='catalyst-eval'` with the extended `emit_buy_suggestion` tool.
9. Citation stripper validates that every cited articleId resolves to a real `Article` row. Suggestions whose every citation is hallucinated are dropped.
10. `capValidator` enforces the single-position and sector caps post-purchase.
11. Persist `Insight` with `kind=BuySuggestion`, `triggeredBy='catalyst:<EventKind>'`, `actionJson.catalystKind`, `actionJson.conjunctionLevel`, `actionJson.urgencyHours=48`, `actionJson.urgencyExpiresAt`.
12. Mark consumed `MarketEvent` rows as processed.
13. The worker job (`runCatalystEngine`) queues one durable, high-priority Vantage app notification per emitted Insight.

## Tuning via /settings

The Settings page exposes four catalyst knobs in the "Catalyst engine" section:

- **Enable catalyst-driven buy suggestions** — master switch. When OFF the engine returns immediately each tick. Default ON.
- **Max catalyst buys per day** — integer 1-5. Default 2. Tightens the funnel during noisy news weeks.
- **Require multi-signal conjunction** — when ON (default), single-signal level-1 candidates are suppressed. Turning this OFF lets single-signal catalysts through, which is riskier and historically generates more false positives.
- **Daily catalyst spend cap (USD)** — Sonnet spend ceiling for the catalyst pipeline. Default $1.00. When breached the engine logs a warning and skips remaining candidates for the rest of the local-time day.

## Schedule

The cron entry `*/5 9-16 * * 1-5` checks every five minutes from 9 AM through 4:59 PM `America/Toronto`, weekdays only. A cheap indexed precheck skips the engine when no unprocessed catalyst event is waiting. Manual trigger: `POST /jobs/catalyst/run` with the worker secret. The five-minute idempotency bucket means a manual poke during the same window as the scheduled run dedups cleanly.

## Vantage app delivery

Each emitted Insight queues its own Vantage notification. It includes:

- an `Exceptional opportunity` title;
- the recommended trade and compact reasoning;
- a deep link to `/insights/<id>`;
- high Web Push urgency and a 48-hour expiry.

Phone delivery uses the worker's VAPID keys and the iPhone subscription created by Vantage's Settings page. The exceptional-opportunity switch can mute these pushes without disabling the engine or hiding its insights in Vantage. See [`APP_NOTIFICATIONS.md`](./APP_NOTIFICATIONS.md).

## Backtesting

The /backtest page now offers `catalyst-driven` as a strategy. The harness replays historical `MarketEvent` rows of the four catalyst kinds across `[startDate, endDate]`, simulates buys at the next-day open after each event, equal-weight allocates across `catalystMaxPerDay` events per day, and exits at the close `holdingDays` trading days later (5 / 10 / 30 / 60). Output includes the standard equity curve + SPY benchmark, drawdown, CAGR, and trade list.

## Troubleshooting

- **No catalyst suggestions appearing.** Check, in order: (1) `/settings` master toggle is ON, (2) catalyst spend cap is not exhausted (`/ops` shows today's catalyst spend and the cap), (3) `Require multi-signal conjunction` is not blocking your only candidate, (4) the qualityFilter rejection reasons surfaced in worker logs. Common rejection reasons: `no-universe-row` (ticker missing from `TickerUniverse`), `low-mcap` (under $500M), `low-volume` (under $5M average), `no-tier1-news` (no tier-1 article in 30d).
- **Suggestion shows up on /insights but no phone notification.** Check that Vantage is installed from Safari with Add to Home Screen, Settings shows `Connected`, the exceptional-opportunity switch is on, and `/health/deep` reports app push configured with at least one subscription.
- **Engine hits spend cap mid-day.** Default cap is conservative ($1.00). Bump on `/settings` if needed, but expect the LlmCall ledger growth to be modest — Sonnet calls cost ~$0.01-$0.05 each at typical context sizes.
- **PassCooldown blocking a strong catalyst.** Only conjunction level 3 (the full triplet) overrides an active cooldown. For level 1-2 candidates the user must clear the cooldown manually.
- **Per-day cap hit early.** The engine ranks candidates by conjunction strength descending, so the strongest signal of the day clears the cap first. Bump `catalystMaxPerDay` if you want broader coverage during a heavy news cycle.
