-- Run independently so PostgreSQL can build the index without blocking ordinary writes.
-- IF NOT EXISTS also tolerates a development database that previously ran the
-- original local-group migration before the index was moved here.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "runs_trigger_status_groupReviewScheduledAt_completedAt_idx"
ON "runs"("trigger", "status", "groupReviewScheduledAt", "completedAt");
