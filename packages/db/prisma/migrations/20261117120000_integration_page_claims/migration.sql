-- App owners claim their integration page through the plugin submission queue. A claim names
-- the page and carries no repository or testing notes, and may keep the page's logo.
ALTER TABLE "plugin_submissions" ADD COLUMN "claim" TEXT;
ALTER TABLE "plugin_submissions" ALTER COLUMN "logo" DROP NOT NULL;
ALTER TABLE "plugin_submissions" ALTER COLUMN "source" DROP NOT NULL;
ALTER TABLE "plugin_submissions" ALTER COLUMN "testing" DROP NOT NULL;

CREATE INDEX "plugin_submissions_claim_status_idx" ON "plugin_submissions"("claim", "status");
