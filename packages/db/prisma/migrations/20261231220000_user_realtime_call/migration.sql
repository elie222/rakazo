-- Realtime call settings follow the account. Additive and nullable: the previous release
-- ignores the column, and a missing value keeps the standard call.
ALTER TABLE "user" ADD COLUMN "realtimeCall" JSONB;
