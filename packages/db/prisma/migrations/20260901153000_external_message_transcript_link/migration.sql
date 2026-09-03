ALTER TABLE "external_messages" ADD COLUMN "threadMessageId" TEXT;

UPDATE "external_messages" AS external_message
SET "threadMessageId" = run."sourceMessageId"
FROM "runs" AS run
WHERE external_message."runId" = run.id
  AND run."sourceMessageId" IS NOT NULL;

CREATE UNIQUE INDEX "external_messages_threadMessageId_key"
ON "external_messages"("threadMessageId");

ALTER TABLE "external_messages"
ADD CONSTRAINT "external_messages_threadMessageId_fkey"
FOREIGN KEY ("threadMessageId") REFERENCES "messages"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
