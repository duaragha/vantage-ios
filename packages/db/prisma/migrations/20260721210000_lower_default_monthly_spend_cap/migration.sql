-- Keep existing operator-selected limits intact while making new installs and
-- newly created settings rows conservative by default.
ALTER TABLE "UserSettings"
ALTER COLUMN "monthlySpendCapUsd" SET DEFAULT 10.0;
