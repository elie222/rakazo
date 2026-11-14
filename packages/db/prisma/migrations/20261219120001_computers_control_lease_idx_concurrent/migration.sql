-- Sole statement so CREATE INDEX CONCURRENTLY runs outside an implicit transaction.
-- The job reconciler pages held control leases in expiry order every pass; only
-- the few computers under control belong in the index.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "computers_control_lease_idx"
ON "computers" ("controlLeaseExpiresAt", "id")
WHERE "controlLeaseId" IS NOT NULL;
