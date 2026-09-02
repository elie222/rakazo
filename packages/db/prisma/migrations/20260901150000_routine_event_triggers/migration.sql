-- AlterTable
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "eventTriggers" JSONB NOT NULL DEFAULT '[]';

-- Backfill webhook-enabled routines into the first-class trigger list.
UPDATE "routines"
SET "eventTriggers" = jsonb_build_array(
  jsonb_build_object('id', 'migrated-webhook', 'kind', 'webhook')
)
WHERE "webhookEnabled" = true
  AND ("eventTriggers" = '[]'::jsonb OR "eventTriggers" IS NULL);
