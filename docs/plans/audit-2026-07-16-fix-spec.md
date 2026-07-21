# Vantage Audit Fix Spec — 2026-07-16

Source: five-agent audit (compare, insights, chat, live staleness probe, full app sweep) run 2026-07-16.
Status: phases 1-6 implemented. Production acceptance is complete except for
the external BotFather credential and the required 48-hour scheduler soak.
Owner: Raghav. Scope: solo Canadian self-directed investor (Wealthsimple; TFSA/RRSP/Personal/Margin; CAD+USD holdings).

## Acceptance checkpoint (2026-07-17)

- Full release gates pass with 400 tests, typecheck, lint, production build,
  Prisma validation, Compose validation, formatting, and a high-severity
  dependency audit.
- The exact revision is deployed to the gaming PC Docker host. Web, worker,
  and Postgres are healthy, run non-root where applicable, and all 25 Croner
  schedules are registered under `America/Toronto`.
- Authenticated browser acceptance covers every dashboard route, mixed-currency
  labels, all 14 Compare signals, US and TSX fundamentals, SPY alpha, score
  trends, chat threads, rendered GFM tables, and mixed-exchange Discovery.
- A forced database outage returned styled route-level failures on all 17
  database-backed pages with no white pages, raw Prisma errors, or stack traces.
- Synthetic non-digest failure and silent-schedule probes each persisted one
  durable self-alert, then their test rows were removed. A stop-loss probe also
  persists to the same durable outbox within its poll cycle.
- Tiingo's changed `endDate` semantics are handled as feed-relative recency,
  and any requested exchange returning zero symbols now fails the universe job
  instead of recording a false success.
- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` remain intentionally unset until
  Raghav creates the dedicated bot in BotFather. Pending deliveries remain in
  the durable queue and live phone delivery is the only skipped acceptance.
- The final 48-hour soak starts with the latest deployment of this exact tree.
- `pnpm --filter @vantage/worker verify:audit-soak -- <worker-started-at>`
  enumerates every daily-or-less-frequent Toronto cron slot in that window and
  fails until every slot succeeded with no post-baseline failed JobRun rows.
- Deep health reports legitimate in-flight jobs as `running` and only fails an
  in-flight job after the one-hour stuck-job ceiling.
  Completion requires every expected daily slot to succeed with no unexplained
  failed or abandoned JobRun rows.

## Already done (ops, 2026-07-16 evening)

- Root-caused the 26h insight outage: node-cron 4.2.1 stops re-firing exact-time daily jobs after their first occurrence, while interval/range jobs keep running. No errors, no failed JobRuns; the scheduler simply never invokes them again.
- Restarted `vantage-worker` (all 22 jobs re-registered), manually backfilled `thesis.batch` (5 evaluated, 0 changes), `discover.compute` (succeeded 23:31 UTC), `poll.eodHistory`, and the evening digest (quiet session, 0 insights).
- Discovered `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` are EMPTY in the worker container: every digest push and self-alert has been a silent no-op this whole deploy.

The restart is a stopgap. Phase 2 makes it permanent.

---

## Phase 1 — Currency correctness (CRITICAL)

**Objective:** No engine or page anywhere treats a CAD amount as USD. Every dollar figure is either converted with a real rate or explicitly labeled.

**Why first:** cap checks and rebalance suggestions currently run on numbers that are wrong by the FX rate whenever CAD positions are involved. This can hide a real concentration breach or emit a false trim. It corrupts real decisions, silently.

### 1.1 Rebalance/concentration engine FX

- `packages/core/src/rebalance/metrics.ts` `computeConcentration()` already supports mixed currency via `currencies`/`usdCadRate` params and `convertToUsdWithRate`. Its two production callers never pass them:
  - `packages/core/src/rebalance/engine.ts:178-181`
  - `packages/core/src/discover/rotation.ts:271-273`
- Fix: thread position currency + a live USD/CAD rate through both call sites. Rate source: same helper the portfolio page uses (it does this correctly).

### 1.2 Digest/catalyst portfolio audits FX

- `packages/core/src/digests/monthly.ts:234-263` and `packages/core/src/catalyst/engine.ts:796-820` (`auditPortfolio()`) sum `shares × avgCost` with no currency check, and the total feeds LLM prompts verbatim ("Total portfolio value: $X") plus per-ticker/sector cap checks.
- Fix: same conversion treatment. One shared "portfolio value in USD (and CAD)" helper, used by all four sites, so this class of bug can't fork again.

### 1.3 Position detail page currency labels

- `apps/web/src/app/(dashboard)/positions/[ticker]/page.tsx:141-145,188-191` renders avgCost/currentPrice/P&L through `fmtUsd()` unconditionally, never reads `Position.currency`.
- Fix: use the existing `fmtMoney()` (portfolio page pattern) which prefixes CAD with `C$`.

### Acceptance criteria

- Unit test: mixed portfolio ($50k USD + C$50k CAD @ 1.36) produces ~$86.8k total and correct weights in `computeConcentration`, `auditPortfolio`, and rotation cap checks; a cap breach masked by the old math is now detected (regression test with exact fixture).
- A CAD position's detail page shows `C$` on every money figure.
- Grep gate: no remaining caller of `computeConcentration` without currency args.

---

## Phase 2 — Pipeline reliability

**Objective:** daily jobs cannot silently die again, and when anything fails, a Telegram message arrives within the hour.

### 2.1 Replace node-cron

- Swap `node-cron@4.2.1` for `croner` (or `node-schedule`; pick one, croner preferred: actively maintained, timezone-correct, tiny). All 22 schedules in `apps/worker/src/index.ts` move over unchanged (`America/Toronto` timezone preserved).
- Keep expressions identical; this is a scheduler transplant, not a schedule redesign.

### 2.2 Job watchdog

- New lightweight job (interval, e.g. every 30 min, so it survives the exact-time bug class by construction): for each registered schedule, compute expected last-fire time from its cron expression; if no JobRun row exists within 1.5× the expected period, fire `sendSelfAlert('error', 'job silent: <name>', ...)`.
- The watchdog is the insurance policy against ANY future scheduler failure, including the one we just hit (would have caught it in ~1h instead of 26h).

### 2.3 Alert on every job failure

- `apps/worker/src/lib/runJob.ts:153` currently gates self-alerts to `name.startsWith('digest.')`. Remove the gate; alert on all failed JobRuns (sendSelfAlert already debounces).

### 2.4 Wire Telegram for real

- `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` empty in the live worker env. Create a dedicated Vantage bot (keep portfolio pings separate from the Serena bot), set both vars in the PC `.env` + docker-compose, restart, and verify with a test digest push.
- Add both to `.env.example` (they're referenced but undocumented).

### 2.5 Cleanup + hygiene

- Close the orphaned `poll.prices` JobRun row stuck `running` since 2026-07-13 (predates current container; harmless but noisy).
- EDGAR CIK mapping: `pollFilings.ts:135` logs "no CIK for ticker" for ~150-200 of 200 tickers every 5 min (~100k log lines/48h) and degrades 8-K classification. Refresh the `company_tickers.json` sync and rate-limit that log line.
- Investigate the recurring StockTwits 403s (stale auth/User-Agent) while in there.

### Acceptance criteria

- Kill test: stop a daily job's underlying handler (or simulate a missed slot); watchdog telegram arrives within 45 min.
- Force one poll job to throw; telegram failure alert arrives (non-digest job).
- 48h soak after deploy: every daily job has a JobRun row for each expected slot.

---

## Phase 3 — Compare page: real research surface

**Objective:** Compare answers "should I still hold this vs the alternative" with actual fundamentals, not a mystery composite bar. All data below already exists in the DB; this phase is wiring.

### 3.1 Fix the 14-signal truncation (bug, not feature)

- `compare/data.ts:88-95` (`SignalBreakdown`) + `normalizeBreakdown()` (`data.ts:459-481`) only recognize 6 legacy signals; `computeDiscoveryScore` (`packages/core/src/discover/signals.ts:103-118`) writes 14. The dropped 8 (epsGrowth, revenueGrowth, margins, valuation, profitability, balanceSheet, liquidity, size) carry 55% of composite weight per `DEFAULT_WEIGHTS` (`signals.ts:83-101`).
- Fix: extend `SignalBreakdown`/`SIGNAL_KEYS` to all 14 (mirror `DiscoveryTable.tsx`), update the mini-bar chart, and rewrite `explainSwap` (`data.ts:487-539`) to compute deltas over all 14 so the "why" text reflects valuation/growth/quality, not just news/momentum.

### 3.2 Surface TickerMetrics fundamentals

- Add the `prisma.tickerMetrics.findMany` join Discovery already does (`discovery/page.tsx:166-190`) into `loadCompareData`; render a compact fundamentals row per ticker: P/E, EV/EBITDA, ROE, margins, debt/equity, dividend yield + payout.

### 3.3 Analyst consensus + catalyst badges

- Latest `AnalystRecommendation` row through the existing `consensusFromRow()` (`packages/core/src/discover/analystUpgrades.ts`) → "Buy (12/3/1)" badge.
- `MarketEvent` catalyst badges (InsiderCluster/EarningsBeat/Material8K/AnalystUpgrade, last 30d), copied from Discovery's query (`discovery/page.tsx:239-268`).

### 3.4 Relative performance + range

- Add SPY to the `loadMultiWindowReturns` batch (`data.ts:557-605`); show alpha (ticker minus SPY) for 30d/6mo/1y next to absolute return.
- 52-week high/low + % from high from the same 260-bar window already loaded.

### 3.5 Score trend sparkline

- `DiscoveryScore` retains 30 days explicitly "for trend analysis" (`schema.prisma:415`) and nothing reads it. Add a per-ticker score sparkline (rising/falling matters for a momentum-flavored composite).

### 3.6 Lens re-ranking on Compare

- Reuse `scoreForLens`/`passesLensRiskGate` from `DiscoveryTable.tsx:56-109` so the unified table can be re-sorted by Growth/Income/Quality lens.

### 3.7 Fix the staleness badge

- `compare/data.ts` computes `priceIsLive`/`priceAgeSeconds`; `CompareTable.tsx` never reads them and shows DiscoveryScore staleness instead. Show price staleness ("Live 12s" vs "Last close") on the page used to decide trades.

### Acceptance criteria

- All 14 signals render with correct weights; `explainSwap` cites a fundamental signal when it dominates the delta.
- Fundamentals row shows real values for both a US and a TSX ticker (null-safe for CA names where Finnhub is sparse).
- SPY alpha matches hand-computed value for a known window. Price-staleness badge flips when LivePrice is >10 min old.

---

## Phase 4 — Actionable insights: every sell names its replacement

**Objective:** no dead-end recommendations. A trim/exit either names what to buy instead or explicitly says nothing cleared the bar.

### 4.1 Give the trim path the rotation tool

- `rebalance/engine.ts:263` tool list lacks `EMIT_ROTATION_SUGGESTION_TOOL` (the Phase 15 sell-X-buy-Y tool used by digests). Add it so cap-violation trims can become rotations when a candidate exists.
- Y supply: `discover/rotation.ts` ranking by default (already cap/cooldown/tax-aware); when the trimmed position is goal-linked (`goals/loaders.ts` ticker→goal matching), prefer `recommendSecurities()` from `packages/core/src/goals/engine.ts:868` (risk/horizon/account-aware).
- Constraints threaded through: same-account feasibility (`accounts/placement.ts`), both-side PassCooldown, dollar-neutral sizing, post-swap cap re-check, and the replacement must not re-breach the cap the trim was fixing.
- Full `exit` gets the same treatment (tool schema at `tools.ts:333-335` currently forbids targetTicker for exit).

### 4.2 "No replacement found" is an explicit state

- Stamp `replacementConsidered: true/false, replacementFound: true/false` on trim actionJson; UI renders "no candidate cleared the bar" when empty. A one-sided trim must be a legible decision, not a silent gap.

### 4.3 Bug: manual Accept rotation writes wrong fields

- `compare/actions.ts:91-131` `acceptSwapAction` writes `{type:'rotation', ticker, targetTicker}`; every other rotation writer + `RotationCard` (`InsightsFeed.tsx:339-396`) use `trimTicker`/`buyTicker`. Result: the card shows the SELL ticker on both legs and the Bought button prefills the ticker being sold. Fix the field names + a regression test.

### 4.4 Bug: cap-driven 'rotate' drops its target

- `buildRebalanceActionJson` (`engine.ts:981-994`) stores `type:'rebalance'` and no targetTicker even when the model named one via `emit_rebalance_suggestion` action='rotate'. Persist the target and render it (or route these through the rotation actionJson shape entirely).

### 4.5 Bug: thesis cards get buy buttons

- `InsightsFeed.tsx:173` `isActionable` only checks `action.ticker` exists, so "Thesis Weakening → Broken" cards (strongest sell signal in the system) render Bought/Passed buttons like buy suggestions. Gate by action type; thesis cards get "Review position" linking to the position page instead.

### 4.6 Link Compare's TRIM verdict to its own SwapPanel

- `verdict.ts:103-107` renders a TRIM pill with no navigation while `compare/data.ts:391-444` computes a matching SwapPanel card on the same page load. Add the affordance.

### Acceptance criteria

- Simulated cap breach on an Intact-thesis position produces either a two-leg rotation card or an explicit no-candidate note; never a bare trim.
- acceptSwapAction round-trip: accepting VDY→XEI shows XEI as the buy leg and prefills XEI on Bought.
- Thesis-change cards show no Bought/Passed buttons.

---

## Phase 5 — Chat UX

**Objective:** chat output is readable (rendered markdown, real tables) and conversations are organized into sessions.

### 5.1 Markdown rendering (quick win, ship first)

- `ChatClient.tsx:132` dumps raw text into `whitespace-pre-wrap`. Add `react-markdown` + `remark-gfm` (neither installed), render assistant content through it, style tables/code to match `ui/table.tsx` conventions and the FrostedPanel look. User bubbles stay plain text.

### 5.2 Chat sessions

- Schema: new `ChatThread` model (`id, title, createdAt, updatedAt, archivedAt?`), `threadId` FK + index on `ChatMessage` (`schema.prisma:277-283`), additive migration + backfill of existing rows into a "Legacy" thread.
- API: thread list + per-thread messages (extend `GET /api/chat` with `threadId` or add `/api/chat/threads`); `POST /api/chat` accepts/creates threadId. Note: `GET /api/chat` currently has no frontend caller (page queries Prisma directly), so consolidate while in there.
- UI: thread sidebar (reuse Card/FrostedPanel), new-chat button, auto-title from first message.

### 5.3 Honest citations

- `route.ts:365-368` hardcodes citations to the top-3 retrieved articles regardless of use, and web/Tavily URLs the model actually cites never surface structurally. Pass through what was actually used (at minimum: include tool-sourced URLs, drop unconsulted articles).

### Acceptance criteria

- The exact table from the 2026-07-16 screenshot renders as a real table.
- Creating a new chat starts an empty context; old thread still loads intact; legacy history lives in its own thread.
- A reply that used web_search shows that source, not three unrelated articles.

---

## Phase 6 — Hardening + long tail

**Objective:** failures are visible, nothing crashes to a white page, and built-but-dark features either ship or die.

- **Error handling:** root + per-section `error.tsx`, `loading.tsx` on heavy pages (portfolio, discovery, compare, positions/[ticker]); try/catch on `goals/page.tsx` + `goals/[id]/page.tsx`; replace silent catch-to-empty on 8 pages (calendar, chat, insights, theses, watchlist, portfolio/add, portfolio/import, ops/positions inner catches) with the existing `dbError` banner pattern.
- **API sanitization:** 9 routes leak raw `err.message` (backtest, chat GET+POST, compare, insights/bought, insights/pass, positions/close, positions/re-evaluate). Generic client message, detail server-logged. compare's catch currently logs nothing server-side.
- **Auth depth:** add in-handler auth recheck to mutating routes (insights/bought, insights/pass, positions/close, positions/re-evaluate, backtest), mirroring the hardening `/api/chat` POST already got.
- **Lottery gate:** wire `detectLotteryFromBars` (`qualityGates.ts:241`) into a nightly cron writing `TickerUniverse.isLottery`; today the meme-stock filter on auto buy-suggestions has never fired (spec §17.6 promised it).
- **Fundamentals surfacing:** income/balance/cashflow + ratios on `/positions/[ticker]`; catalyst detail (8-K materiality, guidance direction, insider names) on Discovery/Insights via the existing `chatRetrieval.ts:renderEvent` formatting.
- **Stop-loss / price-target:** new nullable fields on Position (or Thesis), edit UI on position page, checked by `poll.prices` against LivePrice, alert via the (now working) Telegram path.
- **Goal off-track alert:** `snapshotGoals` already computes `onTrack`; alert on transition to false (debounced, once per goal per week).
- **Timezone fixes:** IntradayMove dedup day-boundary in ET not UTC (`pollPrices.ts:372-373`); `chatRetrieval.ts:993` UTC date stamp renders tomorrow's date after ~7pm ET.
- **Cross-account aggregation:** portfolio page combined-ticker view via existing `aggregatePositionsByTicker`.
- **Env hygiene:** add missing vars to `.env.example` (`ADMIN_PASSWORD_HASH_B64`, `TAVILY_API_KEY`, `TELEGRAM_*`, `WORKER_HOST`, etc.); decide fate of dark features (Reddit source: configure creds or remove; TwelveData fallback: configure key, task #129 already half-wired in `priceOracle.ts`).
- **Docs:** README cron table missing 3 jobs; `docs/spec.md` progress log stale (Phase 15/16 built but unchecked); remove stale header comments on the 3 orphaned API routes (`/api/backtest/[id]`, `/api/compare`, `/api/prices/[ticker]`) or delete the routes.
- **Weekend/overnight coverage decision:** rebalance drift currently surfaces only via weekday digests (~9h overnight gap, weekends dark). Decide: acceptable for a buy-and-hold user, or add a weekend cap-check ping.

### Acceptance criteria

- Forced DB outage: every page shows a styled error/banner, zero white pages, zero raw stack traces in responses.
- A known meme ticker gets `isLottery=true` within one nightly run and is excluded from catalyst buy suggestions.
- Stop-loss breach fires a Telegram within one poll cycle.

---

## Sequencing and effort

| Phase            | Size               | Depends on                         |
| ---------------- | ------------------ | ---------------------------------- |
| 1 FX correctness | S                  | none                               |
| 2 Reliability    | M                  | none (2.4 unblocks all alert work) |
| 3 Compare        | M                  | none                               |
| 4 Insights       | M                  | 3.1 helps (shared signal work)     |
| 5 Chat           | 5.1 S / 5.2 M      | none                               |
| 6 Hardening      | L (parallelizable) | 2.4 for alert items                |

1 and 2 first, in that order (correctness before convenience; alerting unblocks verification of everything else). 5.1 is a 30-minute win that can ride along with any phase. 3 and 4 are the product meat. 6 is background-fill between phases.

## Out of scope (explicit)

- Goals risk-tier/strategy redesign (riskRating band model): separate spec from the 2026-06-19 session, not blocked by this work.
- New data providers (real-time L2, options chains, analyst price targets): revisit after Phase 3 proves what free tiers cover.
- Multi-user/auth beyond the single-admin model.
- LLM-written head-to-head verdicts on Compare (deliberate no-LLM design there; revisit once 3.1/3.2 land and the deterministic template has richer inputs).
