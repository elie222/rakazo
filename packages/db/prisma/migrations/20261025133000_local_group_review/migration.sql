-- Local opt-in orchestrator, additive and compatible with stock Rakazo.
-- This marker is used only for completed group delegation runs.
ALTER TABLE "runs" ADD COLUMN "groupReviewScheduledAt" TIMESTAMP(3);
