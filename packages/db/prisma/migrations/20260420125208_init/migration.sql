-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "ThesisStatus" AS ENUM ('Intact', 'Strengthening', 'Weakening', 'Broken');

-- CreateEnum
CREATE TYPE "EventKind" AS ENUM ('Earnings', 'Filing8K', 'BreakingNews', 'IntradayMove', 'SectorNews', 'Macro', 'SentimentSpike');

-- CreateEnum
CREATE TYPE "InsightKind" AS ENUM ('ThesisUpdate', 'Rebalance', 'BuySuggestion', 'Alert');

-- CreateEnum
CREATE TYPE "Confidence" AS ENUM ('Low', 'Medium', 'High');

-- CreateEnum
CREATE TYPE "InsightStatus" AS ENUM ('New', 'Seen', 'Bought', 'Passed', 'Snoozed');

-- CreateEnum
CREATE TYPE "UserFeedback" AS ENUM ('Bought', 'Passed', 'Snoozed');

-- CreateTable
CREATE TABLE "UserSettings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "passwordHash" TEXT NOT NULL,
    "monthlyBudget" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "singlePositionCapPct" DOUBLE PRECISION NOT NULL DEFAULT 15,
    "sectorCapPct" DOUBLE PRECISION NOT NULL DEFAULT 40,
    "intradayMoveThresholdPct" DOUBLE PRECISION NOT NULL DEFAULT 5,
    "passCooldownDays" INTEGER NOT NULL DEFAULT 14,
    "perTickerDailyAlertCap" INTEGER NOT NULL DEFAULT 3,
    "telegramChatId" TEXT,
    "dailySpendCapUsd" DECIMAL(65,30) NOT NULL DEFAULT 2.0,
    "monthlySpendCapUsd" DECIMAL(65,30) NOT NULL DEFAULT 40.0,
    "killSwitch" BOOLEAN NOT NULL DEFAULT false,
    "timezone" TEXT NOT NULL DEFAULT 'America/Toronto',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Position" (
    "id" SERIAL NOT NULL,
    "ticker" TEXT NOT NULL,
    "shares" DECIMAL(65,30) NOT NULL,
    "avgCost" DECIMAL(65,30) NOT NULL,
    "category" TEXT NOT NULL,
    "sector" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "notes" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Thesis" (
    "id" SERIAL NOT NULL,
    "positionId" INTEGER NOT NULL,
    "summary" TEXT NOT NULL,
    "pillars" JSONB NOT NULL,
    "riskFactors" JSONB NOT NULL,
    "status" "ThesisStatus" NOT NULL DEFAULT 'Intact',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastValidatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Thesis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ThesisEvaluation" (
    "id" SERIAL NOT NULL,
    "thesisId" INTEGER NOT NULL,
    "prevStatus" "ThesisStatus" NOT NULL,
    "newStatus" "ThesisStatus" NOT NULL,
    "rationale" TEXT NOT NULL,
    "citations" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "embedding" vector(384),

    CONSTRAINT "ThesisEvaluation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Watchlist" (
    "id" SERIAL NOT NULL,
    "ticker" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,
    "addedBy" TEXT NOT NULL,

    CONSTRAINT "Watchlist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Article" (
    "id" SERIAL NOT NULL,
    "sourceTier" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "domain" TEXT,
    "url" TEXT NOT NULL,
    "headline" TEXT NOT NULL,
    "body" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "tickers" TEXT[],
    "clusterId" TEXT,
    "trustedCitable" BOOLEAN NOT NULL DEFAULT true,
    "satireBlocked" BOOLEAN NOT NULL DEFAULT false,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "embedding" vector(384),

    CONSTRAINT "Article_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketEvent" (
    "id" SERIAL NOT NULL,
    "kind" "EventKind" NOT NULL,
    "ticker" TEXT,
    "payload" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Insight" (
    "id" SERIAL NOT NULL,
    "kind" "InsightKind" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "reasoning" TEXT NOT NULL,
    "citations" JSONB NOT NULL,
    "actionJson" JSONB,
    "confidence" "Confidence" NOT NULL,
    "status" "InsightStatus" NOT NULL DEFAULT 'New',
    "userFeedback" "UserFeedback",
    "triggeredBy" TEXT NOT NULL,
    "clusterId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Insight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PassCooldown" (
    "id" SERIAL NOT NULL,
    "ticker" TEXT NOT NULL,
    "actionKind" TEXT NOT NULL,
    "until" TIMESTAMP(3) NOT NULL,
    "insightId" INTEGER,

    CONSTRAINT "PassCooldown_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" SERIAL NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "citations" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LlmCall" (
    "id" SERIAL NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "cachedTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(65,30) NOT NULL,
    "purpose" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LlmCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobRun" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "metadata" JSONB,

    CONSTRAINT "JobRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BacktestRun" (
    "id" SERIAL NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "config" JSONB NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BacktestRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Position_ticker_key" ON "Position"("ticker");

-- CreateIndex
CREATE UNIQUE INDEX "Thesis_positionId_key" ON "Thesis"("positionId");

-- CreateIndex
CREATE UNIQUE INDEX "Watchlist_ticker_key" ON "Watchlist"("ticker");

-- CreateIndex
CREATE UNIQUE INDEX "Article_url_key" ON "Article"("url");

-- CreateIndex
CREATE INDEX "Article_publishedAt_idx" ON "Article"("publishedAt");

-- CreateIndex
CREATE INDEX "Article_tickers_idx" ON "Article"("tickers");

-- CreateIndex
CREATE INDEX "Insight_createdAt_idx" ON "Insight"("createdAt");

-- CreateIndex
CREATE INDEX "Insight_status_idx" ON "Insight"("status");

-- CreateIndex
CREATE INDEX "PassCooldown_until_idx" ON "PassCooldown"("until");

-- CreateIndex
CREATE UNIQUE INDEX "PassCooldown_ticker_actionKind_key" ON "PassCooldown"("ticker", "actionKind");

-- CreateIndex
CREATE INDEX "LlmCall_createdAt_idx" ON "LlmCall"("createdAt");

-- CreateIndex
CREATE INDEX "JobRun_name_startedAt_idx" ON "JobRun"("name", "startedAt");

-- AddForeignKey
ALTER TABLE "Thesis" ADD CONSTRAINT "Thesis_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "Position"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThesisEvaluation" ADD CONSTRAINT "ThesisEvaluation_thesisId_fkey" FOREIGN KEY ("thesisId") REFERENCES "Thesis"("id") ON DELETE CASCADE ON UPDATE CASCADE;
