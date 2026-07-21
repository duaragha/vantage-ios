# Event backlog investigation

**Date:** 2026-05-22
**Incident:** 933 unprocessed `MarketEvent` rows accumulated and were manually drained.
**Window of leak:** 2026-05-01 22:39:23 UTC → 2026-05-22 13:15:26 UTC (~20 days, 14 hours).

---

## TL;DR — Root cause

**The Anthropic API was unreachable from the worker for ~20 days. The alert dispatcher's "leave-unprocessed-and-retry" policy turned a transient-error contract into a permanent leak.** Every dispatcher fire pulled the oldest 50 unprocessed events, called `buildAlertFromEvent` → `callClaude`, the SDK threw (no `LlmCall` row was ever written), the catch block at `packages/core/src/alert.ts:219-225` swallowed the error and returned `null` *without setting `processedAt`*. Same 50 rows re-scanned every 30 s for three weeks; new events stacked behind them.

Verified hypothesis: **H2** (operational-error path doesn't set `processedAt`) is the root cause. H1, H3, H5, H6 are not the cause; H4 (poller dedup) is fine.

---

## Evidence

### 1. LLM was completely silent for the leak window

```
SELECT MIN("createdAt") FROM "LlmCall"
WHERE "createdAt" BETWEEN '2026-05-02' AND '2026-05-22 12:00:00';
-- → (no rows)
```

Zero `LlmCall` rows of *any* purpose between **2026-05-01 22:39:23** and **2026-05-22 13:15:26**. The last successful alert call before the gap and the first after:

```
2026-05-01 22:39:23.468 alert  $0.0070  ← last call before outage
2026-05-22 13:15:26.589 alert  ...     ← first call after fix
```

This is not an alert-specific issue. `digest.evening`, `thesis.batch`, `catalyst.run`, `ticker-extract` — all silent. `JobRun.metadata` for `digest.evening` rows in the window confirms it:

```json
{"failedSources": ["llm:digest-evening"], "llmCallIds": [], "tokens": {...all zero...}}
```

(Source: `JobRun` row for `digest.evening` at 2026-05-05 20:30, 2026-05-06 20:30, 2026-05-07 20:30, 2026-05-18 20:30, 2026-05-19 20:30. All `succeeded` with `failedSources: ["llm:digest-evening"]`.)

### 2. Kill switch and spend caps were NOT the cause

`UserSettings` (id=1) snapshot:

```
killSwitch=f  dailySpendCapUsd=10  monthlySpendCapUsd=40  perTickerDailyAlertCap=3
```

Total spend 2026-05-01 = $1.78 across all purposes (well under the $10 daily cap). So neither `KillSwitchError`, `SpendCapError`, nor `TickerCapError` would trigger. The thrown exception must have been from inside `getAnthropic()` or `client.messages.create()` — i.e., missing/invalid `ANTHROPIC_API_KEY` or network/SDK failure.

### 3. Dispatcher kept firing — and kept "suppressing" the same events

`alert.dispatch` `JobRun` daily aggregate, from `metadata->'summary'`:

```
day         scanned   created   suppressed   sent
2026-05-21  137,050   0         137,050      0
2026-05-20  143,950   0         143,950      0
2026-05-19  144,000   0         144,000      0
...
2026-05-02  143,950   0         143,950      0
2026-05-01   14,863   10         14,853      0   ← last day with successful creates
```

Every single dispatcher fire reported **exactly 50 events scanned, 50 suppressed, 0 created, 0 sent** for three weeks. The dispatcher was alive (`status='succeeded'` on every run); it just couldn't process anything.

50 events × 2880 fires/day × 20 days ≈ 2.9 M wasted scans on the same ~50-1000 rows.

(Note: source `apps/worker/src/jobs/eventDispatch.ts:48` declares `DEFAULT_LIMIT = 5`, but live data shows fires of 50. Either the deployed worker is an older build, or `sweepUnprocessedEvents` is being invoked somewhere with its `limit=50` default. Not the root cause of the leak — but worth tracking down separately.)

### 4. Catalyst kinds were never handled by the dispatcher anyway

Drained batch (`processedAt = 2026-05-22 12:30:41.066`):

```
Filing8K        731
IntradayMove    130
Earnings         23
Macro            14
AnalystUpgrade    8
InsiderCluster    5
```

`Earnings`, `AnalystUpgrade`, and `InsiderCluster` events have `occurredAt` spanning 2026-05-06 → 2026-05-21 but `processedAt` clustered at exactly the drain timestamp — they sat unprocessed across the entire window.

(H5 was a reasonable hypothesis but not the cause — `buildAlertFromEvent` is kind-agnostic and would handle every `EventKind`. The catalyst kinds piled up for the same reason as `Filing8K` and `IntradayMove`: the LLM was down.)

### 5. H1 (dispatcher off) — DISPROVEN

```
SELECT date_trunc('day', "startedAt") AS day, COUNT(*)
FROM "JobRun" WHERE name='alert.dispatch' GROUP BY 1 ORDER BY 1 DESC;
```

Dispatcher fired 2,879-2,880 times per day (= 2880/30s fires) every weekday of the window. The only gaps are 2026-05-15/16/17 (likely worker downtime) and 2026-05-14 partial (379 fires) / 2026-05-18 partial (689 fires). None of these gaps are large enough to explain a 933-event backlog.

### 6. H4 (poller dedup) — POLLER LOGIC IS FINE

- `pollPrices.ts:210-225` — dedups `IntradayMove` per ticker per direction per day.
- `pollFilings.ts` — dedups by SEC accession number.
- `pollEarnings.ts:178-188` — dedups `Earnings` by `(ticker, reportDate)`; `pollEarnings.ts:244-254` dedups `EarningsBeat` similarly.
- `pollAnalysts.ts`, `pollInsiders.ts`, `pollMacro.ts` — emit events once per event-date.

No emitter duplicates events.

---

## Where the leak lives in code

### `packages/core/src/alert.ts:178-226` — the operational-error swallow

```ts
try {
  // ... build callParams ...
  const result = await callClaude(callParams);       // ← throws when LLM down
  // ...
} catch (err) {
  if (err instanceof LlmWrapperError) {
    log.warn?.({ eventId, err: err.message, kind: err.name },
      '[core/alert] LLM wrapper blocked call — leaving event unprocessed');
  } else {
    log.error?.({ eventId, err: err instanceof Error ? err.message : err },
      '[core/alert] Sonnet call failed — leaving event unprocessed');
  }
  return null;                                       // ← processedAt NOT set
}
```

The doc-comment at lines 6-9 makes the intent explicit:

> Operational errors (spend cap, kill switch, network, Claude error) log and return null WITHOUT marking the event processed — the next tick picks it up again.

That contract is sound for *transient* failures (5xx, rate limits, momentary network blips). It's a denial-of-service against itself when the failure is *persistent* (missing API key, expired key, sustained outage). No backoff, no circuit breaker, no max-retry-per-event, no self-alert when the same N events fail M times in a row.

### `apps/worker/src/jobs/eventDispatch.ts:51-136` — the outer loop

The dispatcher faithfully implements the "retry forever" contract: `if (!insight) { result.insightsSuppressed++; continue; }`. It can't distinguish a legitimate suppression (dedup hit, per-ticker cap) from a failure-retry, because both look like `null`. No metric, no observability gap.

---

## Recommended fix

This is a **read-only investigation** — no code was changed. Three layered fixes, ordered by effort:

### Fix 1 (small, highest leverage) — surface persistent LLM failure as a self-alert

`packages/core/src/alert.ts:213-226`: instead of swallowing silently, count consecutive operational failures and trip a self-alert after N (e.g. 50) in a row. Module-level counter is fine for a single-process worker.

```
let consecutiveLlmFailures = 0;
// ... in catch:
consecutiveLlmFailures++;
if (consecutiveLlmFailures === 50) {
  void sendSelfAlert('error', 'alert dispatcher: 50 consecutive LLM failures', { lastErr: err.message });
}
// reset on success
```

This would have surfaced the outage to Telegram on May 1, **20 days** before manual detection.

### Fix 2 (medium) — distinguish "retry" from "give up" in `buildAlertFromEvent`

`packages/core/src/alert.ts:213-226`: introduce a `retryCount` column on `MarketEvent` (or a separate `MarketEventAttempt` table) and bound retries. After (say) 24 failed attempts spread over (say) 4 hours, mark the event `processedAt = now()` and log a `processingFailed: true` flag in payload so it can be inspected later.

Schema change required:

```
// packages/db/prisma/schema.prisma
model MarketEvent {
  // ... existing columns ...
  retryCount Int @default(0)
}
```

In `buildAlertFromEvent` catch block: `await prisma.marketEvent.update({ where: { id: eventId }, data: { retryCount: { increment: 1 } } })`. When `retryCount >= 24`, set `processedAt` and emit a failed-event metric.

### Fix 3 (largest, structural) — separate "alert build" from "LLM call"

Today the same function both fetches context and calls the LLM, so any LLM failure blocks the event indefinitely. Splitting into two phases — (a) build an alert-request row, (b) drain alert-request rows with retry/backoff against the LLM — gives natural visibility into queue depth and per-row attempts. Larger refactor; can be deferred until the smaller fixes ship.

### Bonus — track down the `DEFAULT_LIMIT = 5` vs observed-50 discrepancy

`apps/worker/src/jobs/eventDispatch.ts:48` says `DEFAULT_LIMIT = 5`. Live `JobRun.metadata` shows 50/fire. Either (a) the deployed worker is from before that constant was lowered, or (b) `sweepUnprocessedEvents(limit = 50)` (line 193) is being invoked somewhere instead of `runAlertDispatch`. Worth a `grep` and a redeploy.

---

## Silent-leak rate estimate

During the dead window the worker created events at this rate (`MarketEvent.createdAt` grouped by day, leak window only):

```
2026-05-02:  708   ← initial backfill / first IntradayMove poll
2026-05-04:   13
2026-05-05:   27
2026-05-06:   44
2026-05-07:   73
2026-05-08:   19
2026-05-11:   27
2026-05-12:   49
2026-05-13:   14
2026-05-18:   86
2026-05-19:   44
2026-05-20:   18
2026-05-21:   36
```

Steady-state ignoring the May 2 backfill spike: **~35-50 leaked events/day** (mean 38, median 36). Mix:
- `Filing8K` dominates (~80%), then `IntradayMove` (~14%), then `Earnings`/`Macro`/`AnalystUpgrade`/`InsiderCluster` combined ~6%.

Under the bug, this is exactly the *create* rate — because every newly created event leaks until the next event-drain or manual intervention. On a 7-day rolling basis (the `STALE_DAYS = 7` cutoff in `eventDispatch.ts:49`), the dispatcher would have auto-drained the oldest events to `processedAt = now()` without ever generating an alert, but the dashboard would have shown 250-350 "ghost" events at steady state. The 933 total seen on the morning of the manual drain reflects (a) the May 2 backfill spike (~700 events older than 7 days that *would* have been stale-drained the next time the dispatcher ran), plus (b) ~230 events created in the most recent 7 days.

---

## Sources (file:line)

- `packages/core/src/alert.ts:213-226` — operational-error swallow (no processedAt update)
- `packages/core/src/alert.ts:6-9` — design comment documenting the leave-unprocessed contract
- `apps/worker/src/jobs/eventDispatch.ts:48` — `DEFAULT_LIMIT = 5` (live observed value is 50)
- `apps/worker/src/jobs/eventDispatch.ts:67-73` — 7-day stale auto-drain
- `apps/worker/src/jobs/eventDispatch.ts:86-91` — `insightsSuppressed++` covers both legitimate-suppress and failure-retry (no differentiation)
- `packages/llm/src/client.ts:61-71` — `getAnthropic()` throws plain `Error` if `ANTHROPIC_API_KEY` missing
- `packages/llm/src/client.ts:419-440` — `ensureKillSwitchOff` / `ensureSpendCaps` / `getAnthropic` — any of these can throw, all flow back to the alert.ts:213 catch
- `apps/worker/src/jobs/pollPrices.ts:210-225` — IntradayMove dedup (H4 ruled out)
- `apps/worker/src/jobs/pollEarnings.ts:178-188, 244-254` — Earnings + EarningsBeat dedup
- `packages/core/src/catalyst/engine.ts:122-127, 220-228` — catalyst engine only consumes `InsiderCluster`/`EarningsBeat`/`Material8K`/`AnalystUpgrade` and only within a 24h window; events older than 24h are never touched by the catalyst engine (separate observation — not the root cause of the backlog, but explains why `Earnings` from May 7-12 still sat in the queue).
- `packages/db/prisma/schema.prisma:181-203` — `MarketEvent` model + `EventKind` enum
