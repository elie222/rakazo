-- Sole statement so CREATE INDEX CONCURRENTLY runs outside an implicit transaction.
-- Holds every column the usage reports read, so they scan the index alone instead of each wide row.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "usage_records_spaceId_userId_createdAt_covering_idx" ON "usage_records"("spaceId", "userId", "createdAt") INCLUDE ("fundingSource", "operationKind", "provider", "model", "botId", "runId", "parentRunId", "inputTokens", "outputTokens", "totalTokens", "cacheReadTokens", "costUsd");
