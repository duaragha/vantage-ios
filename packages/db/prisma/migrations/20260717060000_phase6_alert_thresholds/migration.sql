ALTER TABLE "Position"
ADD COLUMN "stopLoss" DECIMAL(65,30),
ADD COLUMN "priceTarget" DECIMAL(65,30),
ADD COLUMN "stopLossAlertedAt" TIMESTAMP(3),
ADD COLUMN "priceTargetAlertedAt" TIMESTAMP(3);

ALTER TABLE "Goal" ADD COLUMN "offTrackAlertedAt" TIMESTAMP(3);

ALTER TABLE "GoalSnapshot" ADD COLUMN "onTrack" BOOLEAN;
