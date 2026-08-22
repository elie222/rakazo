-- Where the deployment owner pulls server updates from. NULL means the official repository on the
-- default branch. The last run is kept as JSON because the process restarts as part of applying an
-- update, so an in-memory record would be lost exactly when the operator needs to read it.
-- One ALTER keeps the schema change atomic even when the migration runner does not wrap a file in
-- an explicit transaction. The lease is database-backed so multiple API processes cannot update
-- the same deployment concurrently; an expiry lets a new owner recover after process death.
ALTER TABLE "deployment_settings"
  ADD COLUMN "updateRepoUrl" TEXT,
  ADD COLUMN "updateBranch" TEXT,
  ADD COLUMN "updateLastRun" TEXT,
  ADD COLUMN "updateLeaseId" TEXT,
  ADD COLUMN "updateLeaseExpiresAt" TIMESTAMP(3);
