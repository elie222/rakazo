ALTER TABLE "runs" ADD COLUMN "botOutcomeReturnedAt" TIMESTAMP(3);

CREATE INDEX "runs_botOutcomeReturnedAt_status_idx"
ON "runs"("botOutcomeReturnedAt", "status");
