-- CreateTable
CREATE TABLE "LivePrice" (
    "id" SERIAL NOT NULL,
    "ticker" TEXT NOT NULL,
    "price" DECIMAL(65,30) NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,

    CONSTRAINT "LivePrice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LivePrice_ticker_key" ON "LivePrice"("ticker");

-- CreateIndex
CREATE INDEX "LivePrice_fetchedAt_idx" ON "LivePrice"("fetchedAt");
