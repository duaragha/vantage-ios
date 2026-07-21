CREATE TABLE "ChatThread" (
  "id" SERIAL NOT NULL,
  "title" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "archivedAt" TIMESTAMP(3),

  CONSTRAINT "ChatThread_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ChatMessage" ADD COLUMN "threadId" INTEGER;

INSERT INTO "ChatThread" ("title", "createdAt", "updatedAt")
SELECT
  'Legacy',
  MIN("createdAt"),
  MAX("createdAt")
FROM "ChatMessage"
HAVING COUNT(*) > 0;

UPDATE "ChatMessage"
SET "threadId" = (SELECT "id" FROM "ChatThread" WHERE "title" = 'Legacy' ORDER BY "id" LIMIT 1)
WHERE "threadId" IS NULL;

ALTER TABLE "ChatMessage" ALTER COLUMN "threadId" SET NOT NULL;

CREATE INDEX "ChatThread_updatedAt_idx" ON "ChatThread"("updatedAt");
CREATE INDEX "ChatMessage_threadId_createdAt_idx" ON "ChatMessage"("threadId", "createdAt");

ALTER TABLE "ChatMessage"
ADD CONSTRAINT "ChatMessage_threadId_fkey"
FOREIGN KEY ("threadId") REFERENCES "ChatThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
