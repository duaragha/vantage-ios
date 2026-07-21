-- AlterTable
ALTER TABLE "TickerUniverse" ADD COLUMN     "cik" TEXT;

-- CreateTable
CREATE TABLE "FundamentalsSnapshot" (
    "id" SERIAL NOT NULL,
    "ticker" TEXT NOT NULL,
    "periodEnd" DATE NOT NULL,
    "periodType" TEXT NOT NULL,
    "reportedAt" TIMESTAMP(3),
    "revenue" DECIMAL(65,30),
    "costOfRevenue" DECIMAL(65,30),
    "grossProfit" DECIMAL(65,30),
    "operatingIncome" DECIMAL(65,30),
    "netIncome" DECIMAL(65,30),
    "epsBasic" DECIMAL(65,30),
    "epsDiluted" DECIMAL(65,30),
    "totalAssets" DECIMAL(65,30),
    "totalLiabilities" DECIMAL(65,30),
    "longTermDebt" DECIMAL(65,30),
    "shortTermDebt" DECIMAL(65,30),
    "totalEquity" DECIMAL(65,30),
    "cash" DECIMAL(65,30),
    "operatingCashFlow" DECIMAL(65,30),
    "freeCashFlow" DECIMAL(65,30),
    "capex" DECIMAL(65,30),
    "sharesOutstanding" DECIMAL(65,30),
    "source" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FundamentalsSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TickerMetrics" (
    "id" SERIAL NOT NULL,
    "ticker" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "peTtm" DOUBLE PRECISION,
    "pegTtm" DOUBLE PRECISION,
    "psTtm" DOUBLE PRECISION,
    "pbTtm" DOUBLE PRECISION,
    "evToEbitda" DOUBLE PRECISION,
    "roeTtm" DOUBLE PRECISION,
    "roicTtm" DOUBLE PRECISION,
    "roaTtm" DOUBLE PRECISION,
    "grossMarginTtm" DOUBLE PRECISION,
    "operatingMarginTtm" DOUBLE PRECISION,
    "netMarginTtm" DOUBLE PRECISION,
    "debtToEquity" DOUBLE PRECISION,
    "currentRatio" DOUBLE PRECISION,
    "quickRatio" DOUBLE PRECISION,
    "dividendYieldTtm" DOUBLE PRECISION,
    "dividendPayoutRatio" DOUBLE PRECISION,
    "revenueGrowthYoy" DOUBLE PRECISION,
    "revenueGrowth5y" DOUBLE PRECISION,
    "epsGrowthYoy" DOUBLE PRECISION,
    "epsGrowth5y" DOUBLE PRECISION,
    "sharesOutstanding" DECIMAL(65,30),
    "marketCapUsd" DECIMAL(65,30),
    "beta" DOUBLE PRECISION,
    "avgVolume30d" DOUBLE PRECISION,
    "avgDollarVolume30d" DOUBLE PRECISION,
    "source" TEXT NOT NULL,

    CONSTRAINT "TickerMetrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FundamentalsSnapshot_ticker_idx" ON "FundamentalsSnapshot"("ticker");

-- CreateIndex
CREATE INDEX "FundamentalsSnapshot_periodEnd_idx" ON "FundamentalsSnapshot"("periodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "FundamentalsSnapshot_ticker_periodEnd_periodType_key" ON "FundamentalsSnapshot"("ticker", "periodEnd", "periodType");

-- CreateIndex
CREATE UNIQUE INDEX "TickerMetrics_ticker_key" ON "TickerMetrics"("ticker");

-- CreateIndex
CREATE INDEX "TickerMetrics_ticker_idx" ON "TickerMetrics"("ticker");
