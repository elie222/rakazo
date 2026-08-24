-- Store mirror target per bot-DM run so concurrent handoffs do not overwrite each other.
DROP INDEX IF EXISTS "chat_groups_watchThreadId_idx";
ALTER TABLE "chat_groups" DROP COLUMN IF EXISTS "watchThreadId";

ALTER TABLE "runs" ADD COLUMN "mirrorThreadId" TEXT;

CREATE INDEX "runs_mirrorThreadId_idx" ON "runs"("mirrorThreadId");
