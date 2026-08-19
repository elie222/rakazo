-- One voice credential per provider per user+workspace, enforced by the schema
-- instead of application code. Drops the label column: connect never let users
-- name a key, so it always mirrored the provider's catalog name.

-- Application code already kept one row per provider; clear any strays before
-- adding the constraint, keeping the newest row.
DELETE FROM "user_voice_credentials" a
USING "user_voice_credentials" b
WHERE a."userId" = b."userId"
  AND a."workspaceId" = b."workspaceId"
  AND a."provider" = b."provider"
  AND (a."updatedAt", a."createdAt", a."id") < (b."updatedAt", b."createdAt", b."id");

ALTER TABLE "user_voice_credentials" DROP COLUMN "label";

DROP INDEX "user_voice_credentials_userId_workspaceId_idx";

CREATE UNIQUE INDEX "user_voice_credentials_userId_workspaceId_provider_key"
ON "user_voice_credentials"("userId", "workspaceId", "provider");
