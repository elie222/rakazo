-- Timestamps are stored as UTC without a time zone and compared with now(), so every session
-- must run in UTC. Without the right to change the database, startup warns instead.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET timezone TO %L', current_database(), 'UTC');
EXCEPTION WHEN insufficient_privilege THEN
  RAISE WARNING 'Could not set the database time zone to UTC; run ALTER DATABASE % SET timezone TO ''UTC'' as its owner', quote_ident(current_database());
END $$;
