-- deferred
-- Sole statement so DROP INDEX CONCURRENTLY runs outside an implicit transaction.
-- runs_recent_user_activity_idx replaces it once the previous release stops reading it.
DROP INDEX CONCURRENTLY IF EXISTS "runs_recent_activity_idx";
