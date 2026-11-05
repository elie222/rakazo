-- Additive: older releases never read or write these columns.
ALTER TABLE "runs" ADD COLUMN "memoryCaptureDueAt" TIMESTAMP(3);
ALTER TABLE "runs" ADD COLUMN "memoryCapturedAt" TIMESTAMP(3);
ALTER TABLE "runs" ADD COLUMN "memoryRecallIds" JSONB;

CREATE INDEX "runs_memoryCaptureDueAt_memoryCapturedAt_idx"
  ON "runs"("memoryCaptureDueAt", "memoryCapturedAt");
