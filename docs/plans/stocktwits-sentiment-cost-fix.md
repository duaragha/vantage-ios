# Plan: kill the StockTwits Haiku spend, keep (improve) the sentiment signal

**Date:** 2026-06-16
**Problem:** ~96% of Vantage's LLM spend (~$14/week) is Claude Haiku classifying tier-3 StockTwits social posts for "materially relevant + satire" at ~919 tokens each (11,759 posts/week). The output feeds only a 2%-weight sentiment signal in the discovery score.
**Outcome:** ~$14/week → ~$0. Sentiment signal preserved and arguably improved (real user bull/bear tags instead of crude keyword counting). Only real news (Finnhub, ~431/week, trivial cost) still hits Haiku.

## Why this is clean (investigation findings)
- The StockTwits adapter (`packages/sources/src/stocktwits.ts:89,99`) ALREADY extracts each post's native bull/bear tag (`m.entities.sentiment.basic`) into a `sentiment` field. It's then **dropped** because `NormalizedArticle` (the base type) has no sentiment field, so the type coercion in `pollNews.ts` loses it and the DB has no column for it. No scraping, no new API needed — just stop discarding it.
- The discovery sentiment signal (`signals.ts sentimentScore`) currently keyword-counts the post TEXT — it doesn't use the native tags or the relevance classification at all. It reads only headline+body. It's consumed by BOTH `computeDiscovery.ts` and `scoreHoldings.ts`.
- Verified no hidden consumer breaks if we skip Haiku on tier-3 and keep the keyword-matched tickers: thesis eval, alert dispatch, chat retrieval, scoreHoldings, discovery all keep working (they filter `satireBlocked:false` and bucket by `tickers[]`, both satisfied).
- Aggregation per ticker/window already exists: `computeDiscovery` queries Articles (30d, `tickers hasSome universe`), buckets by ticker, and passes the tier-3 subset to `sentimentScore`. No new aggregate table needed.

## The change — 3 parts

### Part 1 — Persist the native tag (stop dropping it)
- `packages/sources/src/types.ts`: add optional `socialSentiment?: 'Bullish' | 'Bearish' | null` to `NormalizedArticle` so it survives the coercion in pollNews. (Adapter already sets it.)
- `packages/db/prisma/schema.prisma`: add `socialSentiment String?` to `Article`. Additive migration (`ALTER TABLE "Article" ADD COLUMN "socialSentiment" TEXT;`), applied in-container.
- `apps/worker/src/jobs/pollNews.ts` (~lines 196-220): add `socialSentiment: a.socialSentiment ?? null` to the upsert create + update.
- `packages/db/src/articles.ts`: add `socialSentiment` to `UpsertArticleInput` + thread it (consistency for any helper-based path).
- Result: every StockTwits post stored with its bull/bear tag; null for untagged posts and non-social sources.

### Part 2 — Stop paying Haiku for tier-3 (the cost kill)
- `apps/worker/src/jobs/relevanceFilter.ts`, in `processArticle` right before `classifyWithHaiku` (~line 180): if `article.sourceTier === 3`, set `tickers: matched` + `satireBlocked: false` and return. No Haiku call.
- Real news (tier 1-2) keeps the full Haiku relevance treatment — it's worth it and trivial (~431/week).
- Result: zero Haiku calls on StockTwits.

### Part 3 — Use the native tag in the sentiment signal (free, higher quality)
- `packages/core/src/discover/signals.ts` `sentimentScore(tier3Articles)`: count `a.socialSentiment` (Bullish +1 / Bearish -1) when present; fall back to the existing keyword pos/neg for untagged posts (~57-67% are untagged). Keep the volume dampening + [-0.5, 0.5] clamp.
- No change to `computeDiscovery.ts` or `scoreHoldings.ts` — they already pass `tier3Articles`, which now carry `socialSentiment`.
- Result: the 2% sentiment signal runs on real user bull/bear tags, at $0.

## Tests
- relevanceFilter: tier-3 article → no Haiku call, `tickers=matched`, `satireBlocked=false`; tier 1-2 → Haiku still runs.
- sentimentScore: native-tag counting (e.g. 8 bull / 2 bear → positive); keyword fallback when `socialSentiment` null; mixed tagged/untagged.
- computeDiscovery + scoreHoldings: sentiment for a tier-3-only ticker does not regress.

## Deploy
- Apply migration in-container (`prisma migrate deploy` via vantage-worker).
- Rebuild + redeploy vantage-web + vantage-worker.
- Verify over 24h: `LlmCall` relevance-filter count drops to ~0; only ~431/week Finnhub calls remain. Weekly spend ~$14 → cents.

## Risk / rollback
- Additive migration (non-breaking; old rows + non-social = null). The Haiku gate is one conditional. Rollback = revert the gate. Worst case the 2%-weight sentiment signal shifts slightly. Negligible blast radius.

## Optional follow-ups (NOT in this change)
- Retention/prune job for old tier-3 Articles (11k/week → table bloat over time).
- Skip embedding tier-3 social posts if we never vector-search them (extra saving on the embed worker).
- Batch the remaining real-news relevance calls for 50% off (marginal once volume is tiny).
