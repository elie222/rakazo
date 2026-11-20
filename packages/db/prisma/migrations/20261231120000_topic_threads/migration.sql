-- Additive: the previous release never writes these columns, and every thread it creates
-- still has exactly one owner.
ALTER TABLE "threads" ADD COLUMN "parentMessageId" TEXT;
ALTER TABLE "threads" ADD COLUMN "item" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "threads" ADD COLUMN "settledAt" TIMESTAMP(3);
ALTER TABLE "threads" ADD COLUMN "settledBy" TEXT;

-- NOT VALID lets both constraints commit without scanning threads under their locks; each is
-- validated in its own later migration, which lets reads and writes continue.
ALTER TABLE "threads" ADD CONSTRAINT "threads_parentMessageId_fkey" FOREIGN KEY ("parentMessageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;

-- A topic thread is owned by the bot chat message it replies to.
ALTER TABLE "threads" DROP CONSTRAINT "threads_owner_chk";
ALTER TABLE "threads" ADD CONSTRAINT "threads_owner_chk" CHECK (
  num_nonnulls("botId", "groupId", "externalConversationId", "helperBotId", "parentMessageId") = 1
) NOT VALID;
