ALTER TABLE "user_model_credential_keys"
ADD COLUMN "availableModels" TEXT NOT NULL DEFAULT '',
ADD COLUMN "probedAt" TIMESTAMP(3),
ADD COLUMN "probeError" TEXT NOT NULL DEFAULT '';

UPDATE "user_model_credential_keys" AS k
SET "availableModels" = c."availableModels"
FROM "user_model_credentials" AS c
WHERE k."credentialId" = c."id"
  AND k."isActive" = TRUE
  AND c."availableModels" <> '';
