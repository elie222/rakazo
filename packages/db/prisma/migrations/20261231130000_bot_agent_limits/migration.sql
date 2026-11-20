-- Additive: older releases keep writing bots without these settings.
ALTER TABLE "bots" ADD COLUMN "conversationCompactionMode" TEXT NOT NULL DEFAULT 'automatic';
ALTER TABLE "bots" ADD COLUMN "conversationCompactionTokens" INTEGER;
ALTER TABLE "bots" ADD COLUMN "maxToolCallsPerTurn" INTEGER;
