-- The routine and creation time index answers every lookup by routine, so this one only costs writes.
DROP INDEX CONCURRENTLY IF EXISTS "runs_routineId_idx";
