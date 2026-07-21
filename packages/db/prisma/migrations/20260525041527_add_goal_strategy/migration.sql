-- CreateEnum
CREATE TYPE "GoalStrategy" AS ENUM ('Income', 'Growth', 'Balanced', 'Preservation');

-- AlterTable
ALTER TABLE "Goal" ADD COLUMN     "strategy" "GoalStrategy";
