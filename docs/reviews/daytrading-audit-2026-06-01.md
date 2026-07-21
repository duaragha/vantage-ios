# Day-Trading Goal Feature — Adversarial Quality Audit — 2026-06-01

Hard, research-backed audit of the `DayTrading` goal feature in Vantage. **READ-ONLY**: no source code changed. All findings are backed by the actual code, real DB data (recomputed by hand), or cited research. A concurrent agent is building DCA in this repo; fixes below are written copy-paste-ready to apply **after** that lands.

**Scope read**
- Core: `packages/core/src/goals/dayTradeScanner.ts` (+ `.test.ts`), `engine.ts` (DayTrading branches), `securityPool.ts` (`isYieldTrap` / `YIELD_TRAP_BLOCKLIST`)
- Web: `apps/web/src/app/(dashboard)/goals/[id]/page.tsx` (`DayTradingDetail`), `DayTradeScannerTable.tsx`, `NewGoalForm.tsx`, `EditGoalForm.tsx`, `actions.ts`, `data.ts`, `apps/web/src/components/GoalBadge.tsx`
- DB: live `vantage` Postgres (`DailyBar`, `TickerMetrics`, `TickerUniverse`, `Account`, `Goal`)

**Verification method**: I exported the live `DailyBar`/`TickerMetrics` for the full liquid universe (40 names clearing the $5M floor), re-implemented `computeAtrPct` / `computeRsi` / `recentReturn` / `nearRangeHigh` / `scoreCandidate` / the full `scanDayTradeCandidates` pipeline, and compared outputs to the shipped code. Numbers below are real.

---

## Summary

**Headline verdict on indicator math: TRUSTWORTHY.** True Range, ATR%, RSI, RVOL, the breakout range fraction, and the 1%-risk position calculator are all mathematically correct and internally consistent. I hand-recomputed TSLA (4.27%), AMD (6.63%), and the gap-test case and they match the code exactly. The bugs that matter here are **not** in the arithmetic — they are in (1) **data freshness honesty**, (2) a **factually wrong CRA tax claim**, and (3) **two trading styles that collapse into each other** because a weight term saturates for the entire surviving universe.

Severity counts: **2 Critical · 3 High · 4 Medium · 4 Low · 3 Nit**

### Must-fix list (one line each)
1. **[Critical] CRA tax copy is wrong**: RRSPs are *statutorily exempt* from business-income reclassification; only TFSAs are exposed. The copy says "TFSA/RRSP." (`engine.ts:216-220`, `NewGoalForm.tsx:243-247`)
2. **[Critical] Stale data presented as live signals**: RVOL/ATR are computed from bars 10+ days old (latest bar 2026-05-22; today 2026-06-01) with **no recency disclosure** and **no max-staleness guard**. (`dayTradeScanner.ts:273,349`; `[id]/page.tsx:425-429`)
3. **[High] Scalping ≠ liquidity**: the liquidity term saturates at $15M/day, so a $113M name (AAP) ties the $22B name; TSLA (the most scalpable US stock) is absent. Scalping and ORB produce near-identical rankings. (`dayTradeScanner.ts:178-181,196-201`)
4. **[High] ATR off-by-one vs. its own contract**: `BARS_PER_TICKER=16` yields 15 TRs, then `slice(-14)` silently drops the oldest TR — it's a 14-of-15 average, not the documented "14 TRs fit." (`dayTradeScanner.ts:41,78`)
5. **[High] Fit scores are not comparable across styles** (Momentum tops ~85, MeanReversion tops ~50 on the *same* universe) yet the UI shows a bare `/100` with no per-style context. (`dayTradeScanner.ts:154-203`; `DayTradeScannerTable.tsx:147-149`)
6. **[Medium] Universe silently capped at 400** with no disclosure, and `RVOL` reference window is the 30d metric while the "latest" volume is a single stale bar. (`dayTradeScanner.ts:264,349-355`)

---

## Findings

### [Critical] 1 — CRA tax copy: RRSP is NOT subject to business-income reclassification
**`packages/core/src/goals/engine.ts:216-220`** (and the duplicate in **`NewGoalForm.tsx:243-247`** / **`EditGoalForm.tsx`** style hint)

```ts
const DAY_TRADE_RATIONALE =
  "Day-trade in a non-registered account. Frequent trading in a TFSA/RRSP can be " +
  "reclassified by the CRA as business income — taxing your 'tax-free' gains and " +
  "exposing you to penalties. ...";
```

**What's wrong.** This conflates two completely different regimes. Under **ITA s.146(4)(b)**, an **RRSP (and RRIF) is statutorily exempt from tax on business income earned from *qualified investments*** — you can day-trade qualified securities in an RRSP all day and the income is *not* taxable as business income. A **TFSA has no equivalent** — **ITA s.146.2(6)** makes business income in a TFSA taxable "without exception." This is exactly what the Tax Court held in *Canadian Western Trust Co. (Ahamed) v. The King*, **2023 TCC 17** (appeal dismissed; the appellant's argument that the RRSP s.146(4)(b) exemption should extend to TFSAs was explicitly rejected). So "Frequent trading in a **TFSA/RRSP** can be reclassified … as business income" is **false for the RRSP half**.

**Why it matters (real trader).** This is real-money tax guidance in financial software with a "no mistakes" bar. A user reads this and believes their RRSP day-trading gains are at risk of being taxed as business income — they are not. (The *real* reasons to avoid day-trading in an RRSP are different: withdrawals are taxed as ordinary income at your marginal rate and permanently destroy contribution room — not business-income reclassification of the gains.) Stating an authoritative-sounding tax claim that is wrong is worse than saying nothing.

**Exact fix.** Separate the two regimes:

```ts
const DAY_TRADE_RATIONALE =
  "Day-trade in a non-registered account. Frequent trading in a TFSA can be " +
  "reclassified by the CRA as carrying on a business — making your 'tax-free' gains " +
  "fully taxable (Canadian Western Trust (Ahamed) v. The King, 2023 TCC 17). RRSPs " +
  "are exempt from that reclassification on qualified investments, but RRSP " +
  "withdrawals are taxed as ordinary income and permanently destroy contribution " +
  "room, so they're still the wrong home for active trading. In a Personal/Margin " +
  "account, trading gains are business income (100% inclusion) but you can deduct " +
  "losses and expenses, and Margin enables leverage + short-selling.";
```

And in `NewGoalForm.tsx:245-246` / the `EditGoalForm` equivalent change "frequent trading in a TFSA/RRSP risks CRA business-income reclassification" → "frequent trading in a **TFSA** risks CRA business-income reclassification (RRSP withdrawals are taxed and burn room)."

> Note: the **"100% inclusion"** framing for the non-registered/Personal/Margin case is **correct** and well-supported — when the CRA treats you as a trading business, 100% of gains are business income (vs. the 50% capital-gains inclusion for investors). Keep it.

---

### [Critical] 2 — Stale daily bars are presented as if current; no freshness guard or disclosure
**`dayTradeScanner.ts:273`** (`barCutoff = now - 45 days`), **`:349`** (`latestVolume = trimmed[last].volume`), **`[id]/page.tsx:425-429`** (disclaimer)

**What's wrong.** The scanner takes the **single most recent bar in the table** as "latest volume" for RVOL and the latest close for ATR%/price — but never checks **how old** that bar is. Against the live DB right now:

- Today (env) = **2026-06-01**. Latest `DailyBar` across the whole table = **2026-05-22** — **10 calendar days / ~6 trading days stale**.
- Staleness is also **uneven across tickers**: of the 40 liquid names, 13 end on 2026-05-22, 26 end on **2026-05-21**, and 1 ends on **2026-05-18**. So the "RVOL" column compares *different stale dates* per row to a 30-day average and renders them side-by-side as if comparable.
- The UI disclaimer (`page.tsx:425-429`) says candidates are "derived from daily (end-of-day) data, not live intraday signals" — good on the intraday point — but **never states the data could be a week-plus old.** The table's empty-state (`DayTradeScannerTable.tsx:82-85`) even says "Check back after the next end-of-day data refresh," implying the data is fresh-as-of-yesterday.

**Why it matters (real trader).** "RVOL 4.8x" on RGTI reads as *today's* unusual volume — a classic day-trade trigger. It is actually the relative volume of a bar from ~10 days ago. Acting on a week-old volume spike as if it were live is precisely the mistake this feature claims to protect against. A volatility/volume watchlist with no "as of" date is misleading on a real-money surface.

**Exact fix (two parts).**

1. Carry the as-of date through to the UI. In `dayTradeScanner.ts`, add `asOf: Date | null` to `DayTradeCandidate` and set it from the last bar:
```ts
// in the candidate push (~line 374)
asOf: trimmed[trimmed.length - 1]!.date,
```
2. Show it + a staleness warning in `DayTradeScannerTable.tsx` (and/or the section subheader at `page.tsx:464-466`). Minimum: render each row's `asOf` and, when the freshest `asOf` is older than ~2 trading days, a banner:
```tsx
// derive once from candidates
const freshest = candidates.reduce<Date | null>((m, c) => (c.asOf && (!m || c.asOf > m) ? c.asOf : m), null);
const staleDays = freshest ? Math.round((Date.now() - freshest.getTime()) / 86_400_000) : null;
// then, above the table:
{staleDays !== null && staleDays > 3 ? (
  <div className="mb-2 rounded border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-amber-300">
    ⚠ Latest end-of-day data is {staleDays} days old (as of {freshest!.toLocaleDateString('en-CA')}).
    These RVOL/ATR readings are NOT current — re-validate live before trading.
  </div>
) : null}
```
   (Optional hard guard: in `scanDayTradeCandidates`, skip a ticker whose last bar is older than N trading days, or at least sort fresher bars first. Given the loosely-throttled poller, surfacing the staleness is the priority over silently dropping rows.)

---

### [High] 3 — "Scalping" does not rank by what scalpers actually need; collapses into ORB
**`dayTradeScanner.ts:194-201`** (Scalping) and **`:174-181`** (ORB)

```ts
case 'Scalping':
  fit += Math.min(advolM / 15, 1) * 60; // up to 60 — liquidity is everything
  fit += Math.min(rvol, 4) * 6;
  fit += Math.min(atr, 6) * 2;
```

**What's wrong.** The liquidity term **saturates at $15M/day** (`advolM/15` clamped to 1). But the universe floor is **$5M** and every *real* surviving name is **$100M–$22B/day** — so **100% of candidates max out the liquidity term**. Liquidity therefore contributes a constant 60 to every row and stops differentiating anything. What's left (`rvol*6 + atr*2`) makes Scalping rank by ATR + a little RVOL — i.e. **the same drivers as ORB** (`atr*7 + saturated-liquidity*25 + rvol*4`). Measured on the live universe, the two styles' top-15 are nearly identical:

| Style | Top 5 (real data) |
|------|------|
| ORB | RGTI 97, ABCL 87, RKLB 86, AAOI 84, AAON 84 |
| Scalping | RGTI 96, **AAP 96**, ACM 84, ABCL 81, AAL 80 |

The tell: **AAP (Advance Auto Parts, ~$113M/day) ties RGTI at the top of Scalping**, while **TSLA — the single most liquid/scalpable US equity at $22.5B/day — does not appear in the Scalping top-15 at all** (its ATR is "only" 4.27%, so the un-saturated terms bury it). For a style whose entire thesis is "deepest liquidity / tightest spread," ranking a $113M auto-parts name above a $22B mega-cap is backwards.

**Why it matters.** A user who picks "Scalping" expecting the tightest-spread, deepest-book names gets an ATR-sorted list dominated by mid-caps. The style label is a promise the scorer doesn't keep, and ORB/Scalping being interchangeable defeats the per-style design.

**Exact fix.** Don't saturate liquidity at the floor; scale it across the *realistic* range and de-emphasize ATR for scalping (scalpers want tight ranges + volume, not 9% ATR):
```ts
case 'Scalping': {
  // Liquidity is the point — scale across the real range ($5M..$5B+), don't clamp at $15M.
  // log10($M): $5M→0.7, $100M→2, $1B→3, $22B→4.35. Map ~[0.7,4] → [0,60].
  const liq = Math.max(0, Math.min(1, (Math.log10(Math.max(advolM, 1)) - 0.7) / (4 - 0.7)));
  fit += liq * 60;
  fit += Math.min(rvol, 4) * 8;          // volume matters for fills
  fit += Math.min(Math.max(atr - 2, 0), 4) * 2; // a little range, but tighter is fine for scalps
  tag = 'liquid scalp candidate — note: most scalpers lose long-term';
  break;
}
```
For ORB, similarly replace `Math.min(advolM / 20, 1) * 25` with the same log-scaled liquidity so it stops being a constant. (Keep ORB ATR-led, but let liquidity actually vary.)

---

### [High] 4 — ATR window off-by-one: 14-of-15 average, contradicting the file's own comment
**`dayTradeScanner.ts:41`** (`BARS_PER_TICKER = 16`), **`:78`** (`recent = trs.slice(-period)`)

**What's wrong.** Comment at `:40-41` says: *"Pull ~15 bars per ticker so a 14-period ATR (needs prevClose → 14 TRs) fits."* But `BARS_PER_TICKER` is **16**, not 15. From 16 bars the loop produces **15 TRs** (`:65-74`), then `recent = trs.slice(-14)` keeps only the last 14 and **silently discards the oldest TR**. So:
- It is **not** a clean "14 TRs fit" — it computes 15 and throws one away.
- The discarded TR is the *oldest*, so the ATR is computed over a slightly more-recent window than the trimmed array implies. Harmless to correctness (still a valid 14-period simple ATR), but the code does not do what its comment claims, which is a maintenance trap for the next editor.

Verified on TSLA: trimmed window = 05-01→05-22 (16 bars) → 15 TRs → trailing-14 mean = 18.20 → ATR% = **4.27%** (drops the 05-04 TR). With `BARS_PER_TICKER=15` you'd get exactly 14 TRs and no silent drop.

**Why it matters.** Low *numeric* impact, but on a "no mistakes" bar a documented contract that the code violates is a real defect — and the next person who "fixes" the comment to match 16 bars will be codifying the wrong mental model. Either honor the comment (pull 15) or honor the data (document 16→15→14).

**Exact fix (cheapest, matches the comment):**
```ts
const BARS_PER_TICKER = 15; // 15 bars → exactly 14 TRs for a 14-period ATR.
```
This makes `trs.length === 14`, so `slice(-14)` is the identity and nothing is dropped. (Re-confirm `computeRsi` still has enough: RSI needs `period+1 = 15` closes; with 15 bars `closes.length === 15` → OK, exactly at the boundary. If you'd rather keep margin for RSI, leave `BARS_PER_TICKER=16` and instead fix the comment to read "16 bars → 15 TRs; ATR uses the trailing 14.")

---

### [High] 5 — Fit scores are not comparable across styles, but the UI shows a bare `/100`
**`dayTradeScanner.ts:154-203`** (per-style ceilings differ); **`DayTradeScannerTable.tsx:40-44,147-149`** (`fitTone` thresholds 75/50 applied uniformly)

**What's wrong.** Each style's weights sum to different effective maxima on a realistic (non-degenerate) candidate, so the *same* universe yields very different score distributions:

| Style | Top score (live universe) | Median of top-15 |
|------|------|------|
| Scalping | 96 | ~77 |
| ORB | 97 | ~80 |
| Momentum | 85 | ~29 |
| Breakout | 75 | ~44 |
| MeanReversion | 50 | ~22 |

A "Momentum 85" is an *excellent* momentum candidate; an "ORB 80" is *mid-pack*. But `fitTone` (`:40-44`) colors **≥75 emerald, ≥50 amber, else gray** for **every** style. Result: a strong MeanReversion list (tops out at 50) renders **entirely amber/gray** — looks like "nothing here is good" — while ORB is a wall of green. The number invites cross-row comparison the model doesn't support.

**Why it matters.** Misleads the user into thinking MeanReversion/Momentum setups are weak relative to ORB/Scalping when it's just an un-normalized scale. On a decision surface that's a real UX-honesty problem.

**Exact fix (pick one).**
- *Cheapest*: relabel the column from an absolute "Fit /100" to a **per-list rank/percentile**, or add a tooltip on the header: "Fit is relative within the selected style; scores are not comparable across styles." (`DayTradeScannerTable.tsx` header `:115-120`.)
- *Better*: normalize each style to a common scale by dividing by that style's empirical max weight-sum before the `Math.round(Math.min(100,…))` clamp, so "80" means the same thing in every style. (Adjust the constants in each `case` of `scoreCandidate` so a realistic strong candidate lands ~85–95 in all five.)

---

### [Medium] 6 — Universe silently capped at 400 with no disclosure
**`dayTradeScanner.ts:264`** (`take: 400`)

**What's wrong.** The candidate universe is the top **400** `TickerMetrics` rows by `avgDollarVolume30d desc`. Today that's a non-issue (only **40** rows clear the $5M floor, and only **99** tickers have *any* bars — full table is 808 metrics rows, 46 with `avgDollarVolume30d`). But the design comment frames the universe as "a few hundred at most"; once the metrics table grows past 400 names clearing the floor, **legit high-liquidity candidates beyond rank 400 are silently dropped** with no UI indication. Since the sort is by dollar-volume desc, the dropped names are the *lower-liquidity* ones — acceptable for a liquidity-gated scan, but it should be stated rather than silent.

**Why it matters.** "Why isn't ticker X here?" with no explanation erodes trust. Low impact today, latent as data grows.

**Exact fix.** Either raise/remove the cap (the `$5M` floor already bounds it), or, when `metricsRows.length === 400`, surface a one-line note ("Scanned the 400 most-liquid names; some lower-liquidity candidates may be omitted"). At minimum, change the comment to flag the truncation risk.

---

### [Medium] 7 — RVOL mixes a single stale bar against a 30-day metric average inconsistently
**`dayTradeScanner.ts:349-355`**

```ts
const latestVolume = trimmed[trimmed.length - 1]!.volume;   // one stale bar
let avgVol = m.avgVolume30d ?? null;                        // TickerMetrics 30d avg (different fetch time)
if (avgVol === null || avgVol <= 0) { /* fall back to bar-derived 16-bar mean */ }
const relativeVolume = avgVol && avgVol > 0 ? latestVolume / avgVol : null;
```

**What's wrong.** Two consistency issues:
1. The numerator is a **single end-of-day bar that may be 10 days old** (Finding 2), while the denominator is `TickerMetrics.avgVolume30d`, computed at the metrics `fetchedAt` — possibly a *different* point in time than the bar. So RVOL isn't "today's volume vs trailing 30d"; it's "some stale day's volume vs a 30d average computed at some other time." Verified AMD: `34,758,602 / 42,351,550 = 0.82x` (the metric average sits above recent bars, so even active names print RVOL < 1).
2. The **fallback** path computes the average over the trimmed **16-bar** window — *including the latest bar itself* — so when `avgVolume30d` is missing, RVOL is `latest / mean(including latest)`, which is biased toward 1.0 and is a different definition than the primary path.

**Why it matters.** RVOL is a primary day-trade trigger; a value that silently shifts definition (metric-30d vs bar-16d-incl-latest) and compares mismatched dates is unreliable. Not *wrong* arithmetic, but not trustworthy as displayed.

**Exact fix.** Compute RVOL from bars only, with a consistent window that **excludes** the latest bar, and document the as-of date (ties into Finding 2):
```ts
const vols = trimmed.map((b) => b.volume).filter((v) => v > 0);
const latestVolume = vols[vols.length - 1] ?? 0;
const priorVols = vols.slice(0, -1);                 // exclude latest from the baseline
const avgVol = priorVols.length > 0
  ? priorVols.reduce((s, v) => s + v, 0) / priorVols.length
  : null;
const relativeVolume = avgVol && avgVol > 0 ? latestVolume / avgVol : null;
```
(If you prefer the 30-day `TickerMetrics` average for stability, keep it — but then *don't* also have a 16-bar-including-latest fallback; make both paths exclude the latest bar and document that RVOL is "latest bar vs trailing average," not "today.")

---

### [Medium] 8 — `Corporate` account silences the CRA warning; arguably it shouldn't be lumped with Personal/Margin for day-trading
**`engine.ts:206-213`** (`REGISTERED_TYPES` excludes `Corporate`), **`:313-327`** (warning fires only when `nonReg.length === 0`)

**What's wrong.** `REGISTERED_TYPES` = {TFSA, RRSP, SpousalRRSP, RESP, LIRA, RRIF}. A **`Corporate`** account is therefore treated as "non-registered," so (a) it suppresses the no-non-registered CRA warning, and (b) `DAY_TRADE_ACCOUNT_RANK = ['Personal','Margin']` means a Corporate-only user gets `bestAccountId = nonReg[0]` = the Corporate account, with the Personal/Margin rationale. Trading *is* fine in a corp, but the **tax treatment is materially different** (corporate investment income, refundable taxes/RDTOH, integration) and the displayed rationale ("trading gains are business income (100% inclusion) … you can deduct losses") is written for an individual, not a CCPC. The engine elsewhere (`recommendSecurities`, `engine.ts:600-601`) explicitly routes Corporate→Personal "for tax math (integrated taxation)," but the day-trade rationale does no such acknowledgement.

**Why it matters.** A corp-account day-trader gets individual-tax framing that doesn't match their entity. Lower-frequency edge (most users won't day-trade in a corp) but it's a correctness gap on a tax surface.

**Exact fix.** Either (a) add `Corporate` to a separate branch that appends a one-liner ("Corporate accounts are taxed on investment income with RDTOH/integration — consult the corporate-tax treatment; this rationale assumes a personal account"), or (b) explicitly keep Corporate as an allowed non-registered home but tweak `DAY_TRADE_RATIONALE` to note the corporate caveat. At minimum document the intentional exclusion of `Corporate` from `REGISTERED_TYPES`.

---

### [Medium] 9 — YieldMax blocklist exclusion is questionable *for a day-trade scanner* (judgment call — surfaced as requested)
**`dayTradeScanner.ts:326`** (`if (isYieldTrap(ticker)) continue;`), blocklist at **`securityPool.ts:991-994`**

**The reasoning, both ways.** For the **buy-and-hold** discovery/curated pools, excluding YieldMax single-stock synthetic covered-call ETFs (TSLY, NVDY, MSTY, …) is **correct** — they bleed NAV via return-of-capital and are wealth-destroyers to *hold*. But this is a **day-trade** scanner, and the whole point of day-trading is intraday *movement and volume*. YieldMax names are frequently **high-ATR, high-RVOL, catalyst-reactive** instruments — exactly the profile the scanner rewards. NAV erosion is a multi-month phenomenon that is **irrelevant to a same-day round-trip**. So from a pure "what moves today" standpoint, excluding them removes legitimately tradable candidates.

**My assessment.** The exclusion is **defensible but should be a deliberate, disclosed policy choice, not silent.** Reasonable product call: keep them out (you don't want a "speculation-reality-check" product steering users into structurally-decaying derivatives, even intraday), **but say so**. A user who knows MSTY is a liquid daily mover will wonder why it never appears. The current code drops them with zero indication.

**Exact fix (if keeping the exclusion).** Add a one-liner to the scanner section footer (`page.tsx:464-466`): "Single-stock option-income ETFs (YieldMax-style) are excluded even here." If you decide intraday tradability outweighs the paternalism, gate the exclusion behind the goal type:
```ts
// keep yield-traps out of buy-and-hold, but they ARE legit intraday movers:
// (only skip them in non-DayTrading contexts)
```
Either way, make it intentional and visible. Currently it's neither.

---

### [Low] 10 — `nearRangeHigh` uses close-vs-high, so a breakout can never read 1.0
**`dayTradeScanner.ts:114-122`**

`nearRangeHigh` returns `lastClose / max(high over last 14)`. Because the window's max-high includes the **current** bar's own high, and a stock essentially never *closes exactly at* its 14-day high, the fraction is structurally `< 1` even for a fresh breakout that closed strong (e.g. close 118 vs intraday high 120 → 0.983). The Breakout scorer (`:166-168`) maps `(proximity-0.9)*400`, so 0.983 → 33 of the 40-pt proximity band rather than the full 40. **Defensible** (closing below the high *is* slightly weaker), and the comment honestly says "1.0 = at the high," but combined with using the **stale** last bar (Finding 2), "near the 14-day high" is really "near the 14-day high *as of ~10 days ago*."

**Fix (optional).** If you want "broke the prior range," compare close to the prior-N high *excluding* the current bar: `Math.max(...window.slice(0, -1).map(b => b.high))`. Minor; document the choice either way.

---

### [Low] 11 — Position-sizing stop is hardcoded at 5% and not user-adjustable; "Trading capital" silently equals the goal target
**`[id]/page.tsx:404-406,485-498`**

The 1%-risk math is **correct** ($25k → $250 risk → 5% stop → $5,000 max position; verified). But:
- `STOP_PCT = 5` is a fixed illustration with no input — every goal shows the same 5% stop regardless of the candidate's actual ATR. A genuinely useful sizer would let the user type a stop (or default it to the candidate's ATR%), since the page even computes per-name ATR%.
- `tradingCapital = goal.targetAmountCad` (`:401`) — the goal "target" field is *relabeled* "Trading Capital (CAD)" in the form (`NewGoalForm.tsx:168`) and reused as the risk base. That's a reasonable overload, but it's implicit; a user who set a "target" of $100k (aspirational) rather than their actual bankroll gets a 1%-risk of $1,000 that doesn't reflect real capital.

**Fix.** Make the stop an input (default to the row's ATR%); add a one-line clarifier under the sizer that "Trading capital = this goal's amount." Low severity (math is right), UX/clarity.

---

### [Low] 12 — Div-by-zero / degenerate guards are present but worth a confirming test
**`dayTradeScanner.ts:80-82, 100, 110, 120, 355`**; **`[id]/page.tsx:406`**

Checked and **correct**: ATR% returns null when `lastClose <= 0` (`:81`); RSI returns 50 on all-flat and 100/0 on all-up/down with no div-by-zero (`:100`); `recentReturn`/`nearRangeHigh` guard `start/hi <= 0`; RVOL guards `avgVol > 0`; the position sizer guards `STOP_PCT > 0` (`page.tsx:406`). A **constant-price** ticker yields ATR%=0 → filtered by `MIN_ATR_PCT` (no crash). A ticker with **<2 bars** → null → skipped (`:329`). **No bug** — but `computeAtrPct` and the constant-price/empty-universe paths have **no dedicated unit test**; the test file (`dayTradeScanner.test.ts`) covers the happy path + gap + <2-bar + non-positive-close but **not** RVOL, `recentReturn`, `nearRangeHigh`, the `MIN_ATR_PCT`/liquidity gates, or empty-universe. Add those (the math is right; lock it in).

---

### [Nit] 13 — RVOL color thresholds will rarely fire given the stale-data reality
**`DayTradeScannerTable.tsx:34-39`** — `rvolTone` warms at ≥1.5 / ≥3. With the metric-30d denominator running above recent bars (Finding 7), most live rows print RVOL 0.6–1.5x, so the "hot" coloring almost never triggers and the column reads cold even for the genuine spike (RGTI 4.8x is the lone red). Cosmetic; resolves once RVOL is recomputed per Finding 7.

### [Nit] 14 — `money()` formatter omits a currency symbol while the column is currency-ambiguous
**`DayTradeScannerTable.tsx:22-23,136`** — "Last" renders `c.lastClose` via `toLocaleString('en-CA', { maximumFractionDigits: 2 })` with **no `$`** and **no currency**, while the per-row currency tag sits in the *Ticker* cell. All live names are USD today, but a CAD row would show a bare number indistinguishable from a USD one in the price column. Minor; add the `$` or echo the row currency next to the price.

### [Nit] 15 — `daysAgoLabel` uses calendar days; a Friday catalyst shown Monday reads "3d ago"
**`dayTradeScanner.ts:224-229`** — calendar-day math on catalyst recency (and the 7-day catalyst cutoff at `:274`) means a Friday event viewed Monday says "3d ago." Cosmetic and arguably fine, but worth a note since everything else here is trading-day-oriented.

---

## Verified-correct (don't re-litigate)

- **True Range formula** (`dayTradeScanner.ts:68-72`): `max(high-low, |high-prevClose|, |low-prevClose|)` — exactly right. Gap test reproduced: 2 bars (close 100 → 105-107 bar) → TR 7 → ATR% 6.6038% matches the test's `(7/106)*100`.
- **ATR% = simple 14-period mean / latest close** (`:76-82`): documented as simple mean (not Wilder) and *does* a simple mean — honest. Hand-checked TSLA = **4.27%**, AMD = **6.63%** against the live DB; both match the code's output bit-for-bit. (Wilder would give 4.14% for TSLA — the code correctly claims simple mean and delivers it.)
- **RSI** (`:89-103`): correct Wilder-window simple-average variant; all-up → 100, all-down → 0, flat → 50, insufficient data → null. No div-by-zero. Honestly labeled "Wilder-style." (It's the simple-average RSI over the last 14 deltas, not recursively smoothed — acceptable and clearly scoped; flag only if you later claim true Wilder smoothing.)
- **`recentReturn(closes, 5)`** (`:106-112`): spans exactly 5 intervals (start index `len-6`), guards `start <= 0`. Correct.
- **Account inversion logic** (`engine.ts:205, 222-224, 313-329`): DayTrading correctly ranks **Personal → Margin only** and excludes all registered types. Traced against the live DB (user has RRSP/TFSA/Personal): `nonReg` resolves to **Personal** only → no warning, picks Personal. ✔
- **CRA warning gating** (`engine.ts:316-320`): fires **only** when the user has zero non-registered live accounts; stays silent when any non-registered account exists. Logic is exactly as specified. ✔ (The *content* of the rationale is the problem — Finding 1 — not the gating.)
- **Position-sizing math** (`[id]/page.tsx:404-406`): 1% of capital → max loss → `risk / (stop/100)` = position size. Verified: $25k → $250 → 5% → $5,000 (5% of $5,000 = $250 = 1%). `STOP_PCT > 0` guard present. ✔
- **`tradingStyle` persistence hygiene** (`actions.ts:58-64, 109-115`): style is persisted only for DayTrading and **cleared** on type-switch away — no stale style left on a converted goal. New/Edit forms mirror each other (`NewGoalForm.tsx` / `EditGoalForm.tsx`). ✔
- **DayTrading bypasses buy-and-hold machinery** (`engine.ts:592` returns `[]`; `data.ts:415-435` skips discovery + curated, runs scanner instead). Clean separation. ✔
- **`isYieldTrap` is applied** (`dayTradeScanner.ts:326`) — uppercases correctly, blocklist hit works. (Whether it *should* apply here is Finding 9; the mechanism is correct.)
- **Per-style differentiation is real** for Momentum / Breakout / MeanReversion (distinct top-3 on live data). Only ORB≈Scalping collapse (Finding 3). The Momentum/Breakout/MeanReversion weightings genuinely reflect their definitions (RVOL+catalyst+return / range-high+volume / RSI-extreme+volatility).
- **Scalping caveat is present and honest** (`dayTradeScanner.ts:200`, `NewGoalForm.tsx:43`, `page.tsx:426`): "most scalpers lose long-term" surfaced in the reason string, the style hint, and the disclaimer.
- **The "1-4% long-term success rate" stat is defensible** — see Research notes. Keep it.
- **Sortable table sorts numeric values, not strings** (`DayTradeScannerTable.tsx:54-68`): numeric keys compared as `av - bv` with `-Infinity` for nulls; only `ticker` uses `localeCompare`. Correct — no string-sort-on-numbers bug. Default sort `fitScore desc`. ✔
- **GoalBadge** (`GoalBadge.tsx:28,41`): DayTrading correctly mapped to the high-alert rose tone + "Day Trading" label. ✔
- **`computeProgress` for DayTrading**: target date is null for DayTrading goals (form forces it, `NewGoalForm.tsx:121`), so `onTrack` is trivially true and no misleading "behind" signal appears on the P&L-style detail. ✔

---

## Research notes (with sources)

### Day-trading success rate — the "1-4%" claim is well-supported
The credible, academically-defensible range for **persistent, net-of-cost** day-trading profitability is **~1-4%**, so the app's "1-4% long-term success rate" is accurate (if anything, slightly generous on the upper bound for *persistent* traders):
- **Chague, De-Losso & Giovannetti (2020)**, "Day Trading for a Living?" — Brazilian equity-futures, 19,646 traders, 2013-2015: of those who persisted **300+ days, only ~3% were profitable**, and **97% lost money**; essentially none earned more than a bank teller's wage. This is the single most-cited modern figure and directly supports the low end.
- **Barber, Lee, Liu & Odean (2014)**, "The Cross-Section of Speculator Skill: Evidence from Day Trading" (Taiwan, 1992-2006): **~20% of day traders are profitable gross of fees in a typical year**, but the share with *persistent, net-of-fee* skill is far smaller — consistent with low-single-digit long-run success.
- **Barber & Odean (2000)**, "Trading Is Hazardous to Your Wealth": the most active traders underperformed the market materially (net ~11.4% vs ~17.9%), establishing that *activity destroys returns* on average.

**Verdict:** keep "1-4%." If you want to cite, "roughly 1-3% are persistently profitable net of costs (Chague et al. 2020; Barber et al. 2014)" is the tightest defensible phrasing.

### CRA: TFSA business-income reclassification vs. RRSP exemption (the Finding-1 basis)
- **TFSA — taxable if carrying on a business.** Under **ITA s.146.2(6)**, business income earned in a TFSA is taxable "without exception." The frequency/holding-period/knowledge/“business-like manner” factors (the CRA's multi-factor test) determine whether trading is a business.
- **RRSP/RRIF — exempt.** Under **ITA s.146(4)(b)**, an RRSP is *exempt* from tax on business income from **qualified investments** — there is **no TFSA equivalent**.
- **Case law:** *Canadian Western Trust Co. (in re Fareed Ahamed TFSA) v. The King*, **2023 TCC 17** — Tax Court held a TFSA that actively traded was carrying on a business and its income was taxable; the appellant's argument to extend the RRSP s.146(4)(b) exemption to TFSAs was **rejected**. (~$15k → ~$600k of speculative trading.) This is current and controlling.
- **100% vs 50% inclusion:** when trading is a *business* (any non-registered account), **100% of gains are business income** (ordinary rates) vs. the **50% capital-gains inclusion** for investors — the app's "100% inclusion" framing is **correct**.

### Screener gates — sane and conventional
- **ATR% ≥ 2%**: consistent with standard day-trade guidance ("at least 2-3% expected move"; ATR-as-%-of-price is the right normalization). Reasonable.
- **RVOL > ~2** is the conventional "something's happening" threshold (the app *gates* on ATR/liquidity, not RVOL — it only displays RVOL — which is fine).
- **$5M/day dollar-volume floor**: conservative-but-defensible. Common retail screens use ~1M shares/day; at a $5+ price that's ≈$5M+, so the floor is in the right ballpark and errs toward fills-you-can-actually-get. Fine.

**Sources**
- [Chague, De-Losso & Giovannetti (2020), "Day Trading for a Living?" (SSRN)](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3423101)
- [Barber, Lee, Liu & Odean, "The Cross-Section of Speculator Skill: Evidence from Day Trading" (Berkeley/Haas PDF)](https://faculty.haas.berkeley.edu/odean/papers/day%20traders/Day%20Trading%20Skill%20110523.pdf)
- [CNBC summary of day-trading loss research](https://www.cnbc.com/2020/11/20/attention-robinhood-power-users-most-day-traders-lose-money.html)
- [Canadian Tax Foundation — "A TFSA Used To Actively Trade Investments May Be Taxable" (Ahamed / Canadian Western Trust, 2023 TCC 17)](https://www.ctf.ca/EN/EN/Newsletters/Canadian_Tax_Focus/2023/2/230203.aspx)
- [Globe and Mail — "Investors who day trade inside TFSAs to face tax bills after ruling"](https://www.theglobeandmail.com/business/article-day-trading-tfsa-income-taxable/)
- [Jamie Golombek — "The CRA is watching how often you trade marketable securities"](https://www.jamiegolombek.com/articledetail.php?article_id=2126)
- [Spring Financial — "An Overview of Day Trading Taxes in Canada" (100% business-income inclusion)](https://springfinancial.ca/blog/boost-your-income/day-trading-taxes-canada/)
- [Wealthsimple — Tax guide for Canadian traders (business income vs capital gains, superficial loss)](https://www.wealthsimple.com/en-ca/learn/tax-canadian-options-traders)
- [DayTradingToolkit — "Stock Screener Filters for Day Trading" (ATR%, RVOL, liquidity thresholds)](https://daytradingtoolkit.com/beginners-guide/stock-screener-filters-day-trading)
- [Deepvue — "Momentum Stocks: Use ATR and ADR" (ATR-as-% screening)](https://deepvue.com/screener/momentum-stocks/)

---

*Audit performed read-only against live `vantage` DB on 2026-06-01. All ATR%/RVOL/fit figures recomputed from real `DailyBar`/`TickerMetrics` rows and matched against the shipped scanner. No source files modified.*
