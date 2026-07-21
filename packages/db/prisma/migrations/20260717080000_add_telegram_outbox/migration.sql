CREATE TYPE "TelegramDeliveryStatus" AS ENUM ('Pending', 'Sending', 'Sent', 'Dead');

CREATE TABLE "TelegramDelivery" (
    "id" SERIAL NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "parseMode" TEXT,
    "disableNotification" BOOLEAN NOT NULL DEFAULT false,
    "disableWebPagePreview" BOOLEAN NOT NULL DEFAULT true,
    "status" "TelegramDeliveryStatus" NOT NULL DEFAULT 'Pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAttemptAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "messageId" INTEGER,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TelegramDelivery_dedupeKey_key" ON "TelegramDelivery"("dedupeKey");
CREATE INDEX "TelegramDelivery_status_nextAttemptAt_idx" ON "TelegramDelivery"("status", "nextAttemptAt");
CREATE INDEX "TelegramDelivery_expiresAt_idx" ON "TelegramDelivery"("expiresAt");
