-- Operator-only preapply; see docs/turn-memory-capture-adoption.md.
-- Commit the brief metadata change before building the legacy index concurrently.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '10s';
ALTER TABLE public."runs"
  ADD COLUMN "memoryCaptureDueAt" TIMESTAMP(3),
  ADD COLUMN "memoryCapturedAt" TIMESTAMP(3),
  ADD COLUMN "memoryRecallIds" JSONB;
COMMIT;
