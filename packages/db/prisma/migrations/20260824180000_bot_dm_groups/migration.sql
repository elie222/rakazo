ALTER TABLE "chat_groups" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'user';
ALTER TABLE "chat_groups" ADD COLUMN "pairKey" TEXT;

CREATE UNIQUE INDEX "chat_groups_pairKey_key" ON "chat_groups"("pairKey");
CREATE INDEX "chat_groups_workspaceId_userId_kind_idx" ON "chat_groups"("workspaceId", "userId", "kind");
