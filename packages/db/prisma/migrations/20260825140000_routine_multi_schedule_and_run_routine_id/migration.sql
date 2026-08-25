-- Routines can now have more than one "when to run" schedule. Existing
-- single-cron rows become a one-element array so nothing loses its schedule.
ALTER TABLE "routines" ADD COLUMN "crons" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
UPDATE "routines" SET "crons" = ARRAY["cron"] WHERE "cron" IS NOT NULL;
ALTER TABLE "routines" ALTER COLUMN "crons" DROP DEFAULT;
ALTER TABLE "routines" DROP COLUMN "cron";

-- Tracks which routine fired a given run, so the routine list can show a
-- live "Running" badge and the run can be linked back to its schedule.
ALTER TABLE "runs" ADD COLUMN "routineId" TEXT;
CREATE INDEX "runs_routineId_idx" ON "runs"("routineId");
ALTER TABLE "runs" ADD CONSTRAINT "runs_routineId_fkey" FOREIGN KEY ("routineId") REFERENCES "routines"("id") ON DELETE SET NULL ON UPDATE CASCADE;
