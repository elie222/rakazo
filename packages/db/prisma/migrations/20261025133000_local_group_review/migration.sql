-- Local opt-in orchestrator, additive and compatible with stock Rakazo.
-- This marker is used only for completed group delegation runs.
ALTER TABLE "runs" ADD COLUMN "groupReviewScheduledAt" TIMESTAMP(3);
CREATE INDEX "runs_trigger_status_groupReviewScheduledAt_completedAt_idx"
ON "runs"("trigger", "status", "groupReviewScheduledAt", "completedAt");
