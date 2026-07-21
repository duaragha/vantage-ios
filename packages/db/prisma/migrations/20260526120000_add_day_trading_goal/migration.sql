-- DayTrading goal type. Behaves fundamentally differently from buy-and-hold
-- goals: inverted account logic (non-registered only — CRA reclassifies
-- frequent registered-account trading as business income), a candidate scanner
-- instead of curated ETFs, and a prominent risk disclaimer.
--
-- All additive: a new GoalType enum value, a new TradingStyle enum, and a
-- nullable Goal.tradingStyle column. Existing rows are untouched.

-- AlterEnum
ALTER TYPE "GoalType" ADD VALUE IF NOT EXISTS 'DayTrading';

-- CreateEnum
CREATE TYPE "TradingStyle" AS ENUM ('Momentum', 'Breakout', 'ORB', 'MeanReversion', 'Scalping');

-- AlterTable
ALTER TABLE "Goal" ADD COLUMN "tradingStyle" "TradingStyle";
