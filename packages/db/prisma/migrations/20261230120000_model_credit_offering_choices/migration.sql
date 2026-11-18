ALTER TABLE "space_model_role_choices" ADD COLUMN "creditOfferingId" TEXT;
ALTER TABLE "user_model_role_choices" ADD COLUMN "creditOfferingId" TEXT;
ALTER TABLE "space_model_role_choices" ADD CONSTRAINT "space_model_role_funding_choice"
  CHECK ("credentialId" IS NULL OR "creditOfferingId" IS NULL);
ALTER TABLE "user_model_role_choices" ADD CONSTRAINT "user_model_role_funding_choice"
  CHECK ("credentialId" IS NULL OR "creditOfferingId" IS NULL);
-- Personal and credit-funded choices for the same model are separate fallbacks.
DROP INDEX "space_model_role_choices_model_connection_key";
CREATE UNIQUE INDEX "space_model_role_choices_model_connection_key"
  ON "space_model_role_choices"("spaceId", "userId", "role", "provider", "modelId", "credentialId", "creditOfferingId") NULLS NOT DISTINCT;
DROP INDEX "user_model_role_choices_model_connection_key";
CREATE UNIQUE INDEX "user_model_role_choices_model_connection_key"
  ON "user_model_role_choices"("userId", "role", "provider", "modelId", "credentialId", "creditOfferingId") NULLS NOT DISTINCT;
