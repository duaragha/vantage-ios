-- AlterTable
ALTER TABLE "MarketEvent" ADD COLUMN     "lastErrorAt" TIMESTAMP(3),
ADD COLUMN     "retryCount" INTEGER NOT NULL DEFAULT 0;
