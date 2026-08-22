-- Where the deployment owner pulls server updates from. NULL means the official repository on the
-- default branch. The last run is kept as JSON because the process restarts as part of applying an
-- update, so an in-memory record would be lost exactly when the operator needs to read it.
ALTER TABLE "deployment_settings" ADD COLUMN "updateRepoUrl" TEXT;
ALTER TABLE "deployment_settings" ADD COLUMN "updateBranch" TEXT;
ALTER TABLE "deployment_settings" ADD COLUMN "updateLastRun" TEXT;
