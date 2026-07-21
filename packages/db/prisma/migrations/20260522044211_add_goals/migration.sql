-- CreateEnum
CREATE TYPE "GoalType" AS ENUM ('Withdrawal', 'DownPayment', 'Vacation', 'TaxBill', 'EmergencyFund', 'Income', 'Retirement', 'Education', 'Custom');

-- CreateEnum
CREATE TYPE "RiskTolerance" AS ENUM ('VeryLow', 'Low', 'Moderate', 'High', 'Aggressive');

-- CreateEnum
CREATE TYPE "SecurityCategory" AS ENUM ('CashEquivalent', 'ShortTermBond', 'IntermediateBond', 'DividendCanadian', 'DividendUS', 'EquityCanadian', 'EquityUS', 'EquityInternational', 'EquityEmerging', 'AllEquity', 'Balanced', 'Growth', 'REIT', 'Speculative', 'Other');

-- AlterTable
ALTER TABLE "TickerUniverse" ADD COLUMN     "category" "SecurityCategory";

-- CreateTable
CREATE TABLE "Goal" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "type" "GoalType" NOT NULL,
    "targetAmountCad" DECIMAL(65,30) NOT NULL,
    "targetDate" TIMESTAMP(3),
    "isWithdrawal" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "riskOverride" "RiskTolerance",
    "accountId" INTEGER,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Goal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoalPosition" (
    "goalId" INTEGER NOT NULL,
    "positionId" INTEGER NOT NULL,
    "allocation" DECIMAL(65,30) NOT NULL DEFAULT 1.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoalPosition_pkey" PRIMARY KEY ("goalId","positionId")
);

-- CreateTable
CREATE TABLE "GoalSnapshot" (
    "id" SERIAL NOT NULL,
    "goalId" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "valueCad" DECIMAL(65,30) NOT NULL,
    "roomCad" DECIMAL(65,30),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoalSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Goal_type_idx" ON "Goal"("type");

-- CreateIndex
CREATE INDEX "Goal_archivedAt_idx" ON "Goal"("archivedAt");

-- CreateIndex
CREATE INDEX "Goal_accountId_idx" ON "Goal"("accountId");

-- CreateIndex
CREATE INDEX "GoalPosition_positionId_idx" ON "GoalPosition"("positionId");

-- CreateIndex
CREATE INDEX "GoalSnapshot_goalId_idx" ON "GoalSnapshot"("goalId");

-- CreateIndex
CREATE INDEX "GoalSnapshot_date_idx" ON "GoalSnapshot"("date");

-- CreateIndex
CREATE UNIQUE INDEX "GoalSnapshot_goalId_date_key" ON "GoalSnapshot"("goalId", "date");

-- AddForeignKey
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoalPosition" ADD CONSTRAINT "GoalPosition_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoalPosition" ADD CONSTRAINT "GoalPosition_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "Position"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoalSnapshot" ADD CONSTRAINT "GoalSnapshot_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
