CREATE TYPE "PositionLotSource" AS ENUM ('Manual', 'Import', 'Legacy');

CREATE TABLE "PositionLot" (
  "id" SERIAL NOT NULL,
  "positionId" INTEGER NOT NULL,
  "acquiredAt" DATE,
  "shares" DECIMAL(65,30) NOT NULL,
  "costPerShare" DECIMAL(65,30) NOT NULL,
  "source" "PositionLotSource" NOT NULL DEFAULT 'Manual',
  "disposedAt" TIMESTAMP(3),
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PositionLot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PositionLot_shares_positive" CHECK ("shares" > 0),
  CONSTRAINT "PositionLot_cost_nonnegative" CHECK ("costPerShare" >= 0)
);

CREATE INDEX "PositionLot_positionId_disposedAt_acquiredAt_idx"
ON "PositionLot"("positionId", "disposedAt", "acquiredAt");

ALTER TABLE "PositionLot"
ADD CONSTRAINT "PositionLot_positionId_fkey"
FOREIGN KEY ("positionId") REFERENCES "Position"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing Position rows are snapshots, not trustworthy trade records. Keep
-- their acquisition date explicitly unknown and preserve closed positions as
-- disposed history instead of pretending openedAt was the broker trade date.
INSERT INTO "PositionLot" (
  "positionId",
  "acquiredAt",
  "shares",
  "costPerShare",
  "source",
  "disposedAt",
  "createdAt",
  "updatedAt"
)
SELECT
  "id",
  NULL,
  "shares",
  "avgCost",
  'Legacy'::"PositionLotSource",
  "closedAt",
  "openedAt",
  "updatedAt"
FROM "Position";
