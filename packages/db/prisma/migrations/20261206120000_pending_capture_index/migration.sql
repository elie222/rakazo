-- Sole statement: the concurrent build must run outside a transaction.
-- Confirmed captures keep their due time, so exclude them from this scan index.
CREATE INDEX CONCURRENTLY "runs_pending_memory_capture_idx"
  ON "runs" ("memoryCaptureDueAt", "id")
  WHERE "memoryCaptureDueAt" IS NOT NULL AND "memoryCapturedAt" IS NULL;
