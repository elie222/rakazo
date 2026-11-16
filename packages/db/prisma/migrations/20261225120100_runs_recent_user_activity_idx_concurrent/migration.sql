-- Sole statement so CREATE INDEX CONCURRENTLY runs outside an implicit
-- transaction. Matches lastActiveSpaceId: terminal runs that are neither ticket
-- work nor a silent routine's, which runs on its own while the person is away.
CREATE INDEX CONCURRENTLY "runs_recent_user_activity_idx"
ON "runs" ("spaceId", "userId", "completedAt" DESC, "updatedAt" DESC, "id" DESC)
WHERE "status" IN ('completed', 'failed', 'cancelled')
  AND "trigger" NOT IN ('tickets', 'silent_routine');
