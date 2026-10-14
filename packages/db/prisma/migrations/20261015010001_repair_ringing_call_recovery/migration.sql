-- Do not rebuild a large message index under a blocking table lock.
-- An invalid or missing index needs an operator's concurrent repair before retry.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index
    WHERE indexrelid = to_regclass('public.messages_call_recovery_idx')
      AND indisvalid
  ) THEN
    RAISE EXCEPTION 'messages_call_recovery_idx is missing or invalid'
      USING HINT = 'Run DROP INDEX CONCURRENTLY IF EXISTS "messages_call_recovery_idx"; then run the concurrent CREATE from 20261015010000_ringing_call_recovery. After it succeeds, run prisma migrate resolve --rolled-back 20261015010001_repair_ringing_call_recovery and prisma migrate deploy.';
  END IF;
END $$;
