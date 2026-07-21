# /goals Feature Audit — 2026-05-25

Product + code audit of the Vantage `/goals` feature. READ-ONLY; no code changed.

Scope read:
- Web: `apps/web/src/app/(dashboard)/goals/` — `page.tsx`, `[id]/page.tsx`, `GoalsTable.tsx`, `NewGoalForm.tsx`, `EditGoalForm.tsx`, `GoalDetailHeader.tsx`, `GoalProgressBar.tsx`, `LinkPositionForm.tsx`, `data.ts`, `actions.ts`
- Core: `packages/core/src/goals/` — `engine.ts`, `securityPool.ts`, `loaders.ts`, `engine.test.ts`
- DB: `packages/db/prisma/schema.prisma` — `Goal`, `GoalPosition`, `GoalSnapshot`
- Worker: `apps/worker/src/jobs/snapshotGoals.ts`, `apps/worker/src/cron.ts`

> Note: a parallel agent is editing `engine.ts` / `securityPool.ts` / `loaders.ts` to add a high-yield tier. Assessment below is about feature/UX completeness, not transient code state.

---

## Summary verdict

**Overall maturity: adequate-to-solid on the recommendation engine, weak on the "track and act" loop.**

The recommendation half of this feature is genuinely strong: a tax-aware account ranker, a risk/strategy/account-aware security picker with a curated pool plus discovery-pick satellite sleeve, a cheap Haiku questionnaire, and a well-tested engine (40+ cases covering `categoriesForGoal` / `recommendSecurities` / strategy / discovery merge). That's the differentiated, hard-to-build part and it's in good shape.

The **tracking and follow-through half is where the product falls down**. Three substantial pieces of backend work are built and then never surfaced to the user:
1. `GoalSnapshot` is written nightly but **never read** — there is no progress-over-time chart anywhere.
2. `detectConflicts` is fully implemented and exported but **never called** outside the engine and its tests — it is dead code.
3. The glide path is computed and drawn as a *target* bar, but it is **never compared to the user's actual allocation**, which is the high-value insight.

On top of that, the "on track" signal is a crude heuristic with a real correctness bug (ignores goal start date), and there is no "what do I do next" nudge despite all the inputs (`shortfallCad`, `requiredMonthlyCad`, recommended securities) being available on the same page.

### Top 3 highest-impact improvements
1. **Surface the snapshot trend as a progress-over-time chart** on the goal detail page. The data is already persisted nightly; this is read-only plumbing + a small chart. Turns "static target" into "trajectory," which is the entire emotional payoff of a goals feature.
2. **Build the "next action" nudge.** Combine `shortfallCad`, `requiredMonthlyCad`, `onTrack`, and the top recommended security into one sentence: "You're $X behind — contribute ~$Y/mo, or add one of {tickers} to close the gap." Every input already exists on the detail page; it's pure composition.
3. **Show glide-path target vs actual allocation.** You already draw the target cash/bond/equity bar; resolve each linked position's category (via `findCurated` / `TickerUniverse.category`, the same resolver `loaders.ts` uses) and draw the user's *actual* mix beside it with a drift callout. This is the single most analytically valuable thing the page could say and most of the machinery exists.

---

## Feature-by-feature

| # | Feature | Rating | Issue | Suggested improvement |
|---|---------|--------|-------|-----------------------|
| 1 | Goal CRUD | **solid** | Validation is sound (name non-empty, amount finite & > 0, date parseable). Archive/unarchive/delete all present with cascade. Delete uses `confirm()`; no undo. Minor: you can still create a semantically odd goal (see "Correctness" — e.g. a `DownPayment` with a date in the past, or `targetDate` < today). | Add a soft warning when `targetDate` is in the past. Consider a toast/undo for delete instead of a blocking `confirm()`. |
| 2 | Progress tracking | **adequate** | %, shortfall, months-left, required/mo all computed (`computeProgress`, engine.ts:856). Multi-currency handled via per-position currency + `usdToCad`. Missing prices fall back to `avgCost` (data.ts:134) — reasonable. **But `onTrack` is a rough linear heuristic with a real bug** (engine.ts:879-887, see Correctness). No goal `createdAt` is fed in, so "expected progress" is fabricated from a 60-mo-ish assumption. | Pass `Goal.createdAt` into `computeProgress` and compute expected % from actual elapsed/total horizon. Add unit tests (currently **zero** test coverage for `computeProgress`). |
| 3 | Account recommendation | **solid** | Tax-aware ranking by type + horizon, room-aware account pick, RRSP-withdrawal warning (engine.ts:275-290). Rationale strings are genuinely good Canadian tax advice. Surfaced clearly on the detail page and in the new-goal preview. | Minor: `bestAccountName` renders as `Account #12 (TFSA)` (data.ts:347) instead of the real account name even though the name is available in `accountSummaries`. Show the actual name. |
| 4 | Security recommendation | **solid** | Strategy × risk × account-tax-fitness, curated pool + discovery satellite, fit scoring, per-account tax rationale, optimal-for-account badge. Well-tested. | Discovery picks only fire for High/Aggressive (data.ts:295) — intentional, documented. Consider a one-line "why no discovery picks" hint for lower-risk goals so the absence isn't confusing. |
| 5 | Strategy axis | **solid** | Income/Growth/Balanced/Preservation, with Auto. Hard constraints (EmergencyFund/short-horizon) correctly override strategy (engine.ts:393-458). UI exposes it as buttons with hints + the AI helper. Tested incl. "strategy overrides type default." | Clear enough. Could add a one-line plain-English summary of what the chosen strategy will do to the recommendations. |
| 6 | Risk + glide path | **adequate** | Glide allocation is computed (`glideAllocation`, engine.ts:979) and **is** rendered on the detail page (target bar, [id]/page.tsx:226-240). **However it is a single static target — not an actual glide** (no shift shown as the date approaches beyond the binary `< 2yr → VeryLow` flip), and crucially it is **never compared to the user's actual holdings.** | Show target-vs-actual (see #3 in Top 3). Optionally render the glide as a curve over the remaining horizon, not a single snapshot. |
| 7 | Position linking | **adequate** | Link/unlink, per-link allocation slider (5%–100%), multi-goal supported by schema (`@@id([goalId, positionId])`). Allocation clamped 0–1 server-side (actions.ts:164). | **No over-allocation warning** when the same position is linked >100% across goals — `detectConflicts` computes exactly this (engine.ts:923) but it's never called. The link form also can't *edit* an existing link's allocation (only create/unlink); the "Currently linked" chips only unlink. |
| 8 | AI questionnaire helper | **solid** | 3 questions → (strategy, risk, isWithdrawal) via Haiku, 256 max tokens, robust JSON extraction + fallbacks, explicitly forbids tax discussion (actions.ts:250-318). Cheap and graceful on failure. | Good. Minor: the helper sets `isWithdrawal` but in `EditGoalForm` the questionnaire is duplicated verbatim from `NewGoalForm` — extract a shared component to avoid drift. |
| 9 | Conflict detection | **weak (dead code)** | `detectConflicts` (engine.ts:900-977) implements allocation-overflow, account-room-shortfall, and horizon-mismatch. It is exported from `index.ts` but **called nowhere** outside the engine + tests. The user never sees any of it. Also the function has a half-finished block (engine.ts:915-921 is an empty loop with a comment admitting "outside our scope"). | Wire it into the goals page (a "Conflicts" banner) and/or the detail page. Finish the per-goal attribution so `allocation-overflow` can name the goals. |
| 10 | Snapshots | **weak (unsurfaced)** | `GoalSnapshot` written nightly at 03:00 UTC (cron.ts:221, snapshotGoals.ts) with `valueCad` + `roomCad`. The job is solid (bulk bar load, single FX fetch, per-goal try/catch, idempotent upsert). **But nothing reads it** — confirmed no `goalSnapshot` query in `apps/web/src`, and no chart lib / `<svg>` / sparkline in the goals UI. The schema comment even promises a "trailing-progress chart" that doesn't exist. | Add the progress-over-time chart (see #1 in Top 3). Also surface `roomCad` trend — it's already captured. |
| 11 | Contribution room | **adequate (engine only)** | The engine *knows* room: `recommendAccount` prefers accounts with room and warns when RRSP-only (engine.ts:265-290); `snapshotGoals` records `roomCad`. **But the goal never tells the user "your target ($X) exceeds available room ($Y) in the recommended account."** `account-room-shortfall` in `detectConflicts` does this across goals but is dead code, and single-goal-vs-room is never checked at all. | Add a single-goal room check on the detail page: compare `targetAmountCad` to the recommended account's `contributionRoomCad`. |
| 12 | Required monthly contribution | **adequate** | Computed (`requiredMonthlyCad`, engine.ts:875) and **shown** on the detail page ("Required / mo", [id]/page.tsx:106). | Not actionable — it's a bare number with no framing. Fold it into the "next action" nudge (#2). Also shows `—` for open-ended goals (correct) but no explanation. |

---

## Dead / unsurfaced code (computed but never shown)

1. **`GoalSnapshot` (entire table)** — written nightly by `snapshotGoals.ts`, scheduled in `cron.ts:221`, defined in `schema.prisma:569`. **Zero reads** in the web app (only reference in `apps/web/src` is the cascade-delete comment at `actions.ts:149`). The schema docstring (schema.prisma:567) and the job docstring (snapshotGoals.ts:22) both claim a "trailing-progress chart" consumer that does not exist. This is the biggest waste — nightly compute + storage with no payoff.
2. **`detectConflicts` (engine.ts:900)** — exported (`index.ts`), tested implicitly via engine, but **never called by any UI, server action, or worker job** (grep: only `engine.ts`, `engine.test`-adjacent, and `dist` artifacts). Three conflict types fully implemented, surfaced nowhere.
3. **Glide-path vs actual allocation** — `glideAllocation` is rendered as a *target* bar ([id]/page.tsx:226), but the user's actual category mix of linked positions is never computed or compared. The category resolver already exists (`findCurated` + `TickerUniverse.category` in `loaders.ts:243`), so the actual-mix side is cheap to build.
4. **`roomCad` in snapshots** — captured nightly but never displayed anywhere.
5. **`placementForLinkedPosition` (engine.ts:1009)** — exported helper, no caller found in goals UI.

---

## Quick wins (< 1 hr each)

- **Wire `detectConflicts` into a banner** on `/goals` (page.tsx) — call it once with all goals/positions/accounts, render any returned messages in an amber box. The function already returns user-ready `message` strings.
- **Single-goal room warning** on the detail page — compare `targetAmountCad` to the recommended account's `contributionRoomCad` and show an amber note when it exceeds. Data already loaded via `loadAccountSummaries()` in `getGoalDetail`.
- **Fix `bestAccountName`** (data.ts:347) to use the real account name instead of `Account #12 (TFSA)` — the name is in `accountSummaries`.
- **Past-date warning** in `NewGoalForm` / `EditGoalForm` when `targetDate < today`.
- **"Required / mo" framing** — change the bare number into "Contribute ~$Y/mo to stay on track" with a tooltip; show a hint instead of `—` for open-ended goals.
- **Extract the duplicated "Help me decide" questionnaire** from `NewGoalForm` and `EditGoalForm` into one shared component (currently ~80 lines copy-pasted).
- **Allow editing an existing link's allocation** in `LinkPositionForm` — the `updateAllocation` action already exists (actions.ts:199); the UI just needs an inline editor on the "Currently linked" chips.

## Bigger investments

- **Progress-over-time chart** (#1) — read `GoalSnapshot` for the goal, render value-vs-target trajectory (and optionally a target glide line). New data loader + chart component. Highest user-visible payoff.
- **"What do I do next" nudge** (#2) — composition of existing signals into a prescriptive sentence, plus a CTA linking the top recommended security into the link/buy flow.
- **Glide-path target vs actual allocation** (#3) — resolve linked-position categories → bucket into cash/bond/equity → render beside the target bar with a drift indicator ("you're 30% equity over target for this horizon").
- **Replace the `onTrack` heuristic** with a horizon-aware model using `Goal.createdAt` (start), `targetDate` (end), and elapsed time. Add the missing `computeProgress` test suite while you're in there.
- **Finish `detectConflicts` per-goal attribution** (engine.ts:915-921 empty loop) so `allocation-overflow` can name which goals share an over-allocated position.

---

## Correctness bugs

1. **`onTrack` ignores when the goal started (engine.ts:879-887).** The comment is candid: "We don't have createdAt here, so approximate: assume 60mo horizon." `expectedPct` is derived purely from `monthsRemaining` against a synthetic total (`Math.max(monthsRemaining + 1, 12)`), so a brand-new goal with $0 saved and 11 months left can be flagged "on track" while a goal that's 90% through its horizon at 50% saved may not be judged against its true elapsed fraction. The expected-progress curve is essentially fabricated. **Impact:** the green/amber/red "on track" badge — the most prominent signal in the table and detail header — is not trustworthy. **Fix:** pass `Goal.createdAt` and compute `expected = elapsed / (elapsed + remaining)`.

2. **Open-ended goals always report `onTrack = true` (engine.ts:887).** `monthsRemaining === null ? true`. Defensible (no deadline = can't be "behind"), and it *does* degrade gracefully (months-left and required/mo correctly show `—`), but combined with the green bar it can read as "you're doing great" on a goal with $0 saved. **Fix:** for open-ended goals, render a neutral state ("no deadline") rather than a green "on track."

3. **No upper bound / sanity on `targetDate`.** A `targetDate` in the past yields `monthsRemaining = 0` (clamped, engine.ts:872-874) and `requiredMonthlyCad = null`, so progress silently shows `—` with no explanation. Not a crash, but confusing. **Fix:** validate/warn on past dates at create/edit time.

4. **`detectConflicts` has an empty no-op loop (engine.ts:915-921)** with a comment acknowledging it does nothing ("for v1 we'll trust callers"). The `allocation-overflow` conflict consequently emits `goalIds: []` (engine.ts:927), so even if surfaced it can't tell the user *which* goals collide. Not a runtime bug (dead code today) but a latent one the moment it's wired up.

5. **Glide-path `< 2yr → VeryLow` is a hard cliff (engine.ts:982).** A goal at 2.01 years can show 80% equity, then flip to 100% cash the next day at 1.99 years. Not wrong, but jarring as a "glide" — a real glide path would ramp. Cosmetic/UX rather than incorrect.

### Performance note (data.ts)
**No N+1 in the list path.** `valuateGoals` (data.ts:150) bulk-loads all linked tickers in one `getLatestBarsForTickers` call and fetches the FX rate once, then maps in memory — good. `getGoalDetail` is a single goal so per-goal engine calls there are fine. The one thing to watch: if `detectConflicts` is later wired into the list page it calls `recommendAccount` per goal in a loop (engine.ts:937) — that's pure/in-memory so it's cheap, just don't add DB calls inside it.

### Mobile / responsive
- **`GoalsTable` is a wide 8-column `<table>`** (GoalsTable.tsx:62) with no horizontal-scroll wrapper and no responsive collapse — it will overflow on phones. Wrap in `overflow-x-auto` or switch to a card layout at small breakpoints.
- **Detail page progress stats use a fixed `grid-cols-4`** ([id]/page.tsx:83) — four mono numbers will cramp/overflow on narrow screens. Make it `grid-cols-2 sm:grid-cols-4`.
- New/Edit forms use `grid-cols-2` with no `sm:` breakpoint (NewGoalForm.tsx:129, EditGoalForm.tsx:113) — two columns of inputs are tight on mobile.
