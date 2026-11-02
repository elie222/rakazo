-- The computer provider an admin chose in Settings, and its encrypted connection settings.
ALTER TABLE "deployment_settings" ADD COLUMN IF NOT EXISTS "computerProvider" TEXT;
ALTER TABLE "deployment_settings" ADD COLUMN IF NOT EXISTS "computerProviderSecretId" TEXT;
