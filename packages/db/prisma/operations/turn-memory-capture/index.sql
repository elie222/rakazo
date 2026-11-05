-- Operator-only preapply; sole statement, outside any transaction.
-- Preserve the exact legacy index, but not its write-blocking build method.
CREATE INDEX CONCURRENTLY "runs_memoryCaptureDueAt_memoryCapturedAt_idx"
  ON public."runs" ("memoryCaptureDueAt", "memoryCapturedAt");
