-- Intraday OHLC on LivePrice. Today's open/high/low from the Alpaca snapshot
-- (IEX), sourced alongside `price` for the scanner-universe pass so the
-- day-trade scanner can anchor entries to TODAY's high/low instead of a
-- multi-day DailyBar high.
--
-- All additive + nullable: existing rows (and held-ticker rows written via the
-- Finnhub/yfinance path) keep null intraday levels, and the scanner falls back
-- to end-of-day levels (disclosed) when they're absent.

-- AlterTable
ALTER TABLE "LivePrice" ADD COLUMN     "dayHigh" DECIMAL(65,30),
ADD COLUMN     "dayLow" DECIMAL(65,30),
ADD COLUMN     "dayOpen" DECIMAL(65,30);
