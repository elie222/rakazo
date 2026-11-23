-- A routine run reads its routine's latest earlier runs; build the index without blocking run writes.
CREATE INDEX CONCURRENTLY "runs_routineId_createdAt_idx" ON "runs"("routineId", "createdAt");
