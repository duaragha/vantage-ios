-- High-yield-high-risk goals tier. Add a CoveredCall SecurityCategory value so
-- the curated pool can carry covered-call ETFs, BDCs, and high-yield credit.
-- Per-security navErosionRisk metadata (securityPool.ts) distinguishes
-- sustainable spread-based income from leveraged yield traps; YieldMax-style
-- single-stock synthetic covered-call ETFs are excluded via YIELD_TRAP_BLOCKLIST.
-- Additive only — existing rows referencing other values are untouched.

ALTER TYPE "SecurityCategory" ADD VALUE IF NOT EXISTS 'CoveredCall';
