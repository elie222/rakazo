-- Whether the mail came through a mailing list, which sends on what anyone on it writes. Null
-- on rows saved before, and by the previous release while it still runs: for those, unknown.
ALTER TABLE "bot_email_messages" ADD COLUMN "mailingList" BOOLEAN;
