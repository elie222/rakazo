ALTER TABLE "chat_groups"
ADD COLUMN "pinned" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "sectionId" TEXT,
ADD COLUMN "archivedAt" TIMESTAMP(3);

CREATE INDEX "chat_groups_workspaceId_userId_archivedAt_pinned_updatedAt_idx"
ON "chat_groups"("workspaceId", "userId", "archivedAt", "pinned", "updatedAt");

CREATE INDEX "chat_groups_sectionId_idx" ON "chat_groups"("sectionId");

ALTER TABLE "chat_groups"
ADD CONSTRAINT "chat_groups_sectionId_fkey"
FOREIGN KEY ("sectionId") REFERENCES "bot_sections"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

DROP INDEX "chat_groups_workspaceId_userId_updatedAt_idx";
