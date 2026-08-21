ALTER TABLE "user_model_credentials" ADD COLUMN "baseUrl" TEXT;
ALTER TABLE "user_model_credentials" ADD COLUMN "availableModels" TEXT NOT NULL DEFAULT '';

ALTER TABLE "bots" ADD COLUMN "modelProvider" TEXT;
ALTER TABLE "bots" ADD COLUMN "modelId" TEXT;
