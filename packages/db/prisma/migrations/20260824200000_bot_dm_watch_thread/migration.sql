-- Track which user-facing bot thread should mirror bot-to-bot DM replies.
ALTER TABLE "chat_groups" ADD COLUMN "watchThreadId" TEXT;

CREATE INDEX "chat_groups_watchThreadId_idx" ON "chat_groups"("watchThreadId");
