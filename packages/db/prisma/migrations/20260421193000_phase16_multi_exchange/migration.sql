-- Phase 16 — Multi-exchange coverage (TSX + NEO + TSX-V).
--
-- Non-destructive: ADD COLUMN with defaults so an in-flight pollTickerUniverse
-- refresh (which may be upserting rows concurrently) keeps working. The
-- UserSettings row exists already so the JSON default applies cleanly.

-- 1. TickerUniverse: currency (derived from exchange), symbolRaw (no suffix).
ALTER TABLE "TickerUniverse"
  ADD COLUMN IF NOT EXISTS "currency"  TEXT NOT NULL DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS "symbolRaw" TEXT;

-- Backfill — every existing row was seeded from Finnhub /stock/symbol?exchange=US,
-- so USD is correct. The default above already applied on ALTER ADD COLUMN,
-- but we leave this explicit backfill for exchanges that are null so any
-- row-at-rest is consistent.
UPDATE "TickerUniverse"
   SET "currency" = 'USD'
 WHERE "currency" = 'USD'
   AND ("exchange" = 'US' OR "exchange" IS NULL OR "exchange" = '');

-- Index on exchange so /discovery can filter by US/CA quickly once the table
-- has tens of thousands of rows.
CREATE INDEX IF NOT EXISTS "TickerUniverse_exchange_idx" ON "TickerUniverse" ("exchange");

-- 2. UserSettings: exchangesEnabled JSON array. Default covers US + TSX
-- because this project's user is Canadian on Wealthsimple.
ALTER TABLE "UserSettings"
  ADD COLUMN IF NOT EXISTS "exchangesEnabled" JSONB NOT NULL DEFAULT '["US", "TO"]'::jsonb;
