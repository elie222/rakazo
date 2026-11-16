-- Released leases are deleted, so a key's fence can no longer count up from its own row. Every
-- take draws from one sequence instead, which never hands out a value twice. The previous release
-- never reads this table, so widening the column is safe while it still runs.
CREATE SEQUENCE "leases_fence_seq" AS BIGINT;
ALTER TABLE "leases" ALTER COLUMN "fence" TYPE BIGINT;
SELECT setval('leases_fence_seq', COALESCE(MAX("fence"), 0) + 1, false) FROM "leases";
