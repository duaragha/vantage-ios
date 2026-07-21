-- CreateTable
CREATE TABLE "DailyBar" (
    "id" SERIAL NOT NULL,
    "ticker" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "open" DECIMAL(65,30) NOT NULL,
    "high" DECIMAL(65,30) NOT NULL,
    "low" DECIMAL(65,30) NOT NULL,
    "close" DECIMAL(65,30) NOT NULL,
    "volume" BIGINT NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'tiingo',
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyBar_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DailyBar_ticker_date_idx" ON "DailyBar"("ticker", "date" DESC);

-- CreateIndex
CREATE INDEX "DailyBar_date_idx" ON "DailyBar"("date");

-- CreateIndex
CREATE UNIQUE INDEX "DailyBar_ticker_date_key" ON "DailyBar"("ticker", "date");
