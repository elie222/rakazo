-- Additive: the previous release never reads or writes this table.
CREATE TABLE "reply_shares" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reply_shares_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "reply_shares_tokenHash_key" ON "reply_shares"("tokenHash");

CREATE INDEX "reply_shares_userId_createdAt_idx" ON "reply_shares"("userId", "createdAt");

CREATE INDEX "reply_shares_spaceId_userId_idx" ON "reply_shares"("spaceId", "userId");

CREATE INDEX "reply_shares_messageId_idx" ON "reply_shares"("messageId");

CREATE INDEX "reply_shares_botId_idx" ON "reply_shares"("botId");

-- A link ends with the message (deleted or cleared), the bot, or the sharer's membership, which
-- also goes when they delete their account.
ALTER TABLE "reply_shares" ADD CONSTRAINT "reply_shares_spaceId_userId_fkey" FOREIGN KEY ("spaceId", "userId") REFERENCES "space_members"("spaceId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "reply_shares" ADD CONSTRAINT "reply_shares_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "reply_shares" ADD CONSTRAINT "reply_shares_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The sharer sees and removes their own links from any Space they are in, and makes one only in
-- the Space they act in; the public read is a named system lookup by token hash.
ALTER TABLE "reply_shares" ENABLE ROW LEVEL SECURITY;
CREATE POLICY reply_shares_tenant ON "reply_shares"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK ("userId" = NULLIF(current_setting('app.user_id', true), '')
     AND "spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY reply_shares_system ON "reply_shares"
  USING ((SELECT app_rls_bypass()));
