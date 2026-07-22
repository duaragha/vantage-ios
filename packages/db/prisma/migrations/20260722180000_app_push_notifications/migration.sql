CREATE TYPE "AppNotificationDeliveryStatus" AS ENUM ('Pending', 'Sending', 'Sent', 'Dead');

CREATE TABLE "WebPushSubscription" (
  "id" SERIAL NOT NULL,
  "endpoint" TEXT NOT NULL,
  "p256dh" TEXT NOT NULL,
  "auth" TEXT NOT NULL,
  "userAgent" TEXT,
  "lastSuccessAt" TIMESTAMP(3),
  "failureCount" INTEGER NOT NULL DEFAULT 0,
  "disabledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WebPushSubscription_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AppNotificationDelivery" (
  "id" SERIAL NOT NULL,
  "dedupeKey" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "tag" TEXT,
  "urgency" TEXT NOT NULL DEFAULT 'normal',
  "status" "AppNotificationDeliveryStatus" NOT NULL DEFAULT 'Pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastAttemptAt" TIMESTAMP(3),
  "sentAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AppNotificationDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WebPushSubscription_endpoint_key" ON "WebPushSubscription"("endpoint");
CREATE INDEX "WebPushSubscription_disabledAt_idx" ON "WebPushSubscription"("disabledAt");
CREATE UNIQUE INDEX "AppNotificationDelivery_dedupeKey_key" ON "AppNotificationDelivery"("dedupeKey");
CREATE INDEX "AppNotificationDelivery_status_nextAttemptAt_idx" ON "AppNotificationDelivery"("status", "nextAttemptAt");
CREATE INDEX "AppNotificationDelivery_expiresAt_idx" ON "AppNotificationDelivery"("expiresAt");
