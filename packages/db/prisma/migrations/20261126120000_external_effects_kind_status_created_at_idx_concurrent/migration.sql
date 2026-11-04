-- Sole statement so CREATE INDEX CONCURRENTLY runs outside an implicit
-- transaction. The worker finds unfinished videos across Spaces by kind and age.
CREATE INDEX CONCURRENTLY "external_effects_kind_status_createdAt_idx" ON "external_effects" ("kind", "status", "createdAt");
