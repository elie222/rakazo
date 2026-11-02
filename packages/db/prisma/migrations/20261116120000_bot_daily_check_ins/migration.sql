ALTER TABLE "bots" ADD COLUMN "dailyCheckIns" BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX "runs_botId_createdAt_idx" ON "runs"("botId", "createdAt");
CREATE INDEX "scratchpad_items_botId_status_updatedAt_id_idx" ON "scratchpad_items"("botId", "status", "updatedAt", "id");
