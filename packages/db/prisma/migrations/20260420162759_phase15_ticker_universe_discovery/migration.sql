-- AlterTable
ALTER TABLE "UserSettings" ADD COLUMN     "discoveryMinMcapUsd" DECIMAL(65,30) NOT NULL DEFAULT 500000000,
ADD COLUMN     "discoveryWeights" JSONB,
ADD COLUMN     "haikuTickerExtractDay" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "haikuTickerExtractUsedToday" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "TickerUniverse" (
    "id" SERIAL NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "sector" TEXT,
    "marketCapUsd" DECIMAL(65,30),
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastRefreshed" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TickerUniverse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscoveryScore" (
    "id" SERIAL NOT NULL,
    "ticker" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "signalBreakdown" JSONB NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscoveryScore_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TickerUniverse_symbol_key" ON "TickerUniverse"("symbol");

-- CreateIndex
CREATE INDEX "TickerUniverse_symbol_idx" ON "TickerUniverse"("symbol");

-- CreateIndex
CREATE INDEX "TickerUniverse_sector_idx" ON "TickerUniverse"("sector");

-- CreateIndex
CREATE INDEX "DiscoveryScore_computedAt_score_idx" ON "DiscoveryScore"("computedAt", "score");

-- CreateIndex
CREATE INDEX "DiscoveryScore_ticker_computedAt_idx" ON "DiscoveryScore"("ticker", "computedAt");
