-- deferred
-- Sole statement so DROP INDEX CONCURRENTLY runs outside an implicit transaction.
-- usage_records_spaceId_userId_createdAt_covering_idx replaces it.
DROP INDEX CONCURRENTLY IF EXISTS "usage_records_spaceId_userId_createdAt_idx";
