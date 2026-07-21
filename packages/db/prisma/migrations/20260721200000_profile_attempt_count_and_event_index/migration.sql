-- Strike counter for the nightly Finnhub profile backfill: symbols whose
-- attempts keep yielding no market cap park on a monthly retry cadence.
ALTER TABLE "TickerUniverse" ADD COLUMN "profileAttemptCount" INTEGER NOT NULL DEFAULT 0;

-- The alert dispatcher prechecks the unprocessed event queue every 30s.
CREATE INDEX "MarketEvent_processedAt_idx" ON "MarketEvent"("processedAt");
