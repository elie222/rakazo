-- Additive: the previous release never reads this table or column.
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "emailSenders" TEXT;

CREATE TABLE "bot_email_addresses" (
    "localPart" TEXT NOT NULL,
    "botId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_email_addresses_pkey" PRIMARY KEY ("localPart")
);

CREATE UNIQUE INDEX "bot_email_addresses_botId_key" ON "bot_email_addresses"("botId");

ALTER TABLE "bot_email_addresses" ADD CONSTRAINT "bot_email_addresses_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE SET NULL ON UPDATE CASCADE;
