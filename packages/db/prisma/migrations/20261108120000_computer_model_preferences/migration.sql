-- Additive only. Existing connections and bots keep following their main model.
ALTER TABLE "user_model_preferences" ADD COLUMN "hasMainPreference" BOOLEAN NOT NULL DEFAULT true, ADD COLUMN "computerModelId" TEXT, ADD COLUMN "computerThinkingLevel" TEXT;
ALTER TABLE "space_model_preferences" ADD COLUMN "computerModelId" TEXT, ADD COLUMN "computerThinkingLevel" TEXT;
ALTER TABLE "bots" ADD COLUMN "computerModel" JSONB;
