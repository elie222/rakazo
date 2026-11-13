-- Whether the mail was an auto-reply or notice about another message, or bulk mail. Null on rows
-- saved before, and by the previous release while it still runs: for those, unknown.
ALTER TABLE "bot_email_messages" ADD COLUMN "autoReplyOrBulk" BOOLEAN;
