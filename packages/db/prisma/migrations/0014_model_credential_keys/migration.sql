CREATE TABLE "user_model_credential_keys" (
  "id" TEXT NOT NULL,
  "credentialId" TEXT NOT NULL,
  "secretId" TEXT NOT NULL,
  "label" TEXT NOT NULL DEFAULT 'API key',
  "isActive" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_model_credential_keys_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "user_model_credential_keys_credentialId_createdAt_id_idx"
ON "user_model_credential_keys"("credentialId", "createdAt", "id");

CREATE UNIQUE INDEX "user_model_credential_keys_one_active_idx"
ON "user_model_credential_keys"("credentialId")
WHERE "isActive" = TRUE;

ALTER TABLE "user_model_credential_keys"
ADD CONSTRAINT "user_model_credential_keys_credentialId_fkey"
FOREIGN KEY ("credentialId") REFERENCES "user_model_credentials"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "user_model_credential_keys" ("id", "credentialId", "secretId", "label", "isActive", "createdAt")
SELECT
  "id",
  "id",
  "secretId",
  'API key',
  TRUE,
  "createdAt"
FROM "user_model_credentials";
