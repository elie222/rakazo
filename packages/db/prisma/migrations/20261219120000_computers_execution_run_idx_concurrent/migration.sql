-- Sole statement so CREATE INDEX CONCURRENTLY runs outside an implicit transaction.
-- Every run cancellation clears the legacy execution binding by run id.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "computers_executionRunId_idx" ON "computers"("executionRunId");
