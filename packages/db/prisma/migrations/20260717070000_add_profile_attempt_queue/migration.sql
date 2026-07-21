ALTER TABLE "TickerUniverse"
ADD COLUMN "profileAttemptedAt" TIMESTAMP(3);

CREATE INDEX "TickerUniverse_profileAttemptedAt_idx"
ON "TickerUniverse"("profileAttemptedAt");
