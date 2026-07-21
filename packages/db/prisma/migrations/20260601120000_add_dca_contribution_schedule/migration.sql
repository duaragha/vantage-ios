-- DCA contribution schedule on Goal. A funding method (scheduled cash
-- contributions) attached to buy-and-hold goals — orthogonal to GoalType.
-- Lets goal projection look FORWARD (contributions + expected return) rather
-- than only backward (createdAt -> now). DayTrading goals never use this.
--
-- All additive: a new ContributionFrequency enum plus three nullable Goal
-- columns. Existing rows are untouched (null schedule = no projection).

-- CreateEnum
CREATE TYPE "ContributionFrequency" AS ENUM ('Weekly', 'Biweekly', 'Monthly', 'Quarterly');

-- AlterTable
ALTER TABLE "Goal" ADD COLUMN     "contributionAmountCad" DECIMAL(65,30),
ADD COLUMN     "contributionFrequency" "ContributionFrequency",
ADD COLUMN     "contributionStartDate" TIMESTAMP(3);
