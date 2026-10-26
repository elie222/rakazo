-- Preserve writes while building the recent activity query's scope and order.
-- Exclude active runs and background ticket work, as listSpaceRuns does.
CREATE INDEX CONCURRENTLY "runs_recent_activity_idx"
ON "runs" ("spaceId", "userId", "completedAt" DESC, "updatedAt" DESC, "id" DESC)
WHERE "status" IN ('completed', 'failed', 'cancelled')
  AND "trigger" NOT IN ('tickets');
