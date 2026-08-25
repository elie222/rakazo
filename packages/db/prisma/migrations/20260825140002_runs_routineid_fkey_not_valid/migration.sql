-- Added NOT VALID so this commits without scanning the table (no write
-- lock), then validated immediately after — VALIDATE CONSTRAINT only takes
-- a SHARE UPDATE EXCLUSIVE lock, so concurrent run creation isn't blocked.
ALTER TABLE "runs" ADD CONSTRAINT "runs_routineId_fkey" FOREIGN KEY ("routineId") REFERENCES "routines"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "runs" VALIDATE CONSTRAINT "runs_routineId_fkey";
