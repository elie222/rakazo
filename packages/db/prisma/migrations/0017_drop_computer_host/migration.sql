-- Bots always run on the provider chosen at deploy time via SANDBOX_PROVIDER, so the
-- per-deployment host override no longer has a meaning.
ALTER TABLE "deployment_settings" DROP COLUMN IF EXISTS "computerHost";
