-- Track the two billable cache directions separately and include Anthropic's
-- per-request web-search surcharge in the durable spend ledger.
ALTER TABLE "LlmCall"
ADD COLUMN "cacheCreationTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "webSearchRequests" INTEGER NOT NULL DEFAULT 0;
