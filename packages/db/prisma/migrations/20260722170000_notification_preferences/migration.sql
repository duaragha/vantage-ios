ALTER TABLE "UserSettings"
ADD COLUMN "notifyBuySuggestions" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "notifyRebalances" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "notifyExceptionalOpportunities" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "notifyScheduledDigests" BOOLEAN NOT NULL DEFAULT true;
