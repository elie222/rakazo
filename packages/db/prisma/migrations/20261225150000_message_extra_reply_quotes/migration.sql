-- A reply can quote several excerpts: the first stays in replyQuote, the rest go here.
ALTER TABLE "messages" ADD COLUMN "extraReplyQuotes" jsonb;
