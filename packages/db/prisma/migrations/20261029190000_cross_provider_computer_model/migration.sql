-- Nullable identity pins preserve legacy same-connection defaults without rewriting preferences.
ALTER TABLE "user_model_preferences" ADD COLUMN "computerProvider" TEXT, ADD COLUMN "computerCredentialId" TEXT;
ALTER TABLE "space_model_preferences" ADD COLUMN "computerProvider" TEXT, ADD COLUMN "computerCredentialId" TEXT;
