-- Phase 18 — tax-aware goals engine.
-- Add new SecurityCategory enum values so the curated pool can carry granular
-- tax-flavour metadata. Additive only — existing rows referencing
-- DividendCanadian/Growth/Speculative are untouched.

ALTER TYPE "SecurityCategory" ADD VALUE IF NOT EXISTS 'LeveragedETF';
ALTER TYPE "SecurityCategory" ADD VALUE IF NOT EXISTS 'SectorEquity';
ALTER TYPE "SecurityCategory" ADD VALUE IF NOT EXISTS 'IndividualStock';
ALTER TYPE "SecurityCategory" ADD VALUE IF NOT EXISTS 'CryptoAdjacent';
