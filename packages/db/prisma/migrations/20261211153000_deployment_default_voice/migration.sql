-- The voice an admin chose in Settings for everyone without their own connection, and its
-- encrypted key.
ALTER TABLE "deployment_settings" ADD COLUMN "defaultVoiceProvider" TEXT;
ALTER TABLE "deployment_settings" ADD COLUMN "defaultVoiceId" TEXT;
ALTER TABLE "deployment_settings" ADD COLUMN "defaultVoiceCredentialCipher" TEXT;
