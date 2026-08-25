-- Store mirror target per bot-DM run so concurrent handoffs do not overwrite each other.
ALTER TABLE "runs" ADD COLUMN "mirrorThreadId" TEXT;

UPDATE "runs" r
SET "mirrorThreadId" = cg."watchThreadId"
FROM "threads" t
JOIN "chat_groups" cg ON cg.id = t."groupId"
WHERE r."threadId" = t.id
  AND cg.kind = 'bot_dm'
  AND cg."watchThreadId" IS NOT NULL
  AND r."mirrorThreadId" IS NULL
  AND r.status IN ('queued', 'leased', 'running', 'waiting_input', 'waiting_takeover');

DROP INDEX IF EXISTS "chat_groups_watchThreadId_idx";
ALTER TABLE "chat_groups" DROP COLUMN IF EXISTS "watchThreadId";

CREATE INDEX "runs_mirrorThreadId_idx" ON "runs"("mirrorThreadId");
