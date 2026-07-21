-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "EventKind" ADD VALUE 'InsiderCluster';
ALTER TYPE "EventKind" ADD VALUE 'EarningsBeat';
ALTER TYPE "EventKind" ADD VALUE 'Material8K';
ALTER TYPE "EventKind" ADD VALUE 'AnalystUpgrade';

-- AlterTable
ALTER TABLE "TickerUniverse" ADD COLUMN     "isLottery" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "UserSettings" ADD COLUMN     "catalystDailySpendCapUsd" DECIMAL(65,30) NOT NULL DEFAULT 1.0,
ADD COLUMN     "catalystEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "catalystMaxPerDay" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "catalystRequireConjunction" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "InsiderTransaction" (
    "id" SERIAL NOT NULL,
    "ticker" TEXT NOT NULL,
    "insiderName" TEXT NOT NULL,
    "insiderTitle" TEXT,
    "transactionDate" TIMESTAMP(3) NOT NULL,
    "transactionCode" TEXT NOT NULL,
    "shares" DECIMAL(65,30) NOT NULL,
    "pricePerShare" DECIMAL(65,30) NOT NULL,
    "valueUsd" DECIMAL(65,30) NOT NULL,
    "filingDate" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'finnhub',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InsiderTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalystRecommendation" (
    "id" SERIAL NOT NULL,
    "ticker" TEXT NOT NULL,
    "period" TIMESTAMP(3) NOT NULL,
    "strongBuy" INTEGER NOT NULL DEFAULT 0,
    "buy" INTEGER NOT NULL DEFAULT 0,
    "hold" INTEGER NOT NULL DEFAULT 0,
    "sell" INTEGER NOT NULL DEFAULT 0,
    "strongSell" INTEGER NOT NULL DEFAULT 0,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalystRecommendation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InsiderTransaction_ticker_filingDate_idx" ON "InsiderTransaction"("ticker", "filingDate");

-- CreateIndex
CREATE UNIQUE INDEX "InsiderTransaction_ticker_insiderName_transactionDate_share_key" ON "InsiderTransaction"("ticker", "insiderName", "transactionDate", "shares");

-- CreateIndex
CREATE INDEX "AnalystRecommendation_ticker_idx" ON "AnalystRecommendation"("ticker");

-- CreateIndex
CREATE UNIQUE INDEX "AnalystRecommendation_ticker_period_key" ON "AnalystRecommendation"("ticker", "period");
