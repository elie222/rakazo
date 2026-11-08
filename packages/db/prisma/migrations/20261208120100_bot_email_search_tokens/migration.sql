-- Blind-index tokens for searching encrypted inbox mail; NULL until encrypted.
ALTER TABLE "bot_email_messages" ADD COLUMN "searchTokens" INTEGER[];
