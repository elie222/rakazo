-- Model provider connections an admin adds in Settings, and which deployment models members
-- may use. Both apply over the environment's.
ALTER TABLE "deployment_settings" ADD COLUMN "allowedModels" TEXT;
CREATE TABLE "deployment_model_connections" (
  "provider" TEXT NOT NULL PRIMARY KEY,
  "settingsId" TEXT NOT NULL DEFAULT 'default' REFERENCES "deployment_settings"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "ciphertext" TEXT NOT NULL,
  "models" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "deployment_model_connections_settingsId_idx" ON "deployment_model_connections"("settingsId");
