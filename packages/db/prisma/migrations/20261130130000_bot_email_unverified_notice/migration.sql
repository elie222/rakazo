-- Additive: the previous release never reads this column.
ALTER TABLE "bot_email_addresses" ADD COLUMN IF NOT EXISTS "unverifiedNoticeAt" TIMESTAMP(3);
