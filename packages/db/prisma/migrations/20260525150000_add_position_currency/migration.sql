-- AlterTable
-- Additive: avgCost is now denominated in the ticker's listing currency.
-- Default 'USD' backfills existing rows (all current holdings are US listings).
ALTER TABLE "Position" ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'USD';
