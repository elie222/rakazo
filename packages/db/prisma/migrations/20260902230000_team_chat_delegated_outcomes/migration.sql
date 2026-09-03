ALTER TABLE "runs" ADD COLUMN "teamChatMirroredAt" TIMESTAMP(3);

CREATE INDEX "runs_trigger_status_teamChatMirroredAt_updatedAt_idx"
  ON "runs"("trigger", "status", "teamChatMirroredAt", "updatedAt");
