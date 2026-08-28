-- Drop an INVALID leftover from an interrupted concurrent build before create.
-- IF NOT EXISTS alone would skip that artifact and report success without a usable index.
-- Plain DROP (not CONCURRENTLY): CONCURRENTLY cannot run inside DO, and incomplete
-- indexes are cheap to remove. Valid same-name indexes are left alone.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_index i ON i.indexrelid = c.oid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'chat_groups_sectionId_idx'
      AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX IF EXISTS "chat_groups_sectionId_idx"';
  END IF;
END $$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "chat_groups_sectionId_idx" ON "chat_groups"("sectionId");
