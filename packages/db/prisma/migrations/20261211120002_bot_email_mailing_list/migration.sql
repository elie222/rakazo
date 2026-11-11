-- Mail that came through a mailing list, which sends on what anyone on it writes. Rows saved
-- before, and by the previous release while it still runs, read as not from a list.
ALTER TABLE "bot_email_messages" ADD COLUMN "mailingList" BOOLEAN NOT NULL DEFAULT false;
