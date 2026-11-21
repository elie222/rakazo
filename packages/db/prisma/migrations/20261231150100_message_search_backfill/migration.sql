-- The maintenance command creates its checkpoint on first use, after the rollout.
CREATE TABLE "message_search_backfill" (
  "version" INTEGER PRIMARY KEY,
  "afterId" TEXT,
  "throughId" TEXT
);

ALTER TABLE "message_search_backfill" ENABLE ROW LEVEL SECURITY;
CREATE POLICY message_search_backfill_system ON "message_search_backfill"
  USING ((SELECT app_rls_bypass()));
