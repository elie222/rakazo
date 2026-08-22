CREATE TABLE "bot_channels" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "botAId" TEXT NOT NULL,
    "botBId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_channels_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "bot_channel_messages" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "fromBotId" TEXT NOT NULL,
    "toBotId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "sourceRunId" TEXT NOT NULL,
    "recipientRunId" TEXT NOT NULL,
    "deliveryKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_channel_messages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "bot_channels_workspaceId_botAId_botBId_key" ON "bot_channels"("workspaceId", "botAId", "botBId");
CREATE INDEX "bot_channels_workspaceId_idx" ON "bot_channels"("workspaceId");
CREATE INDEX "bot_channels_botAId_idx" ON "bot_channels"("botAId");
CREATE INDEX "bot_channels_botBId_idx" ON "bot_channels"("botBId");
CREATE UNIQUE INDEX "bot_channel_messages_deliveryKey_key" ON "bot_channel_messages"("deliveryKey");
CREATE INDEX "bot_channel_messages_channelId_createdAt_id_idx" ON "bot_channel_messages"("channelId", "createdAt", "id");

ALTER TABLE "bot_channels" ADD CONSTRAINT "bot_channels_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bot_channels" ADD CONSTRAINT "bot_channels_botAId_fkey" FOREIGN KEY ("botAId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bot_channels" ADD CONSTRAINT "bot_channels_botBId_fkey" FOREIGN KEY ("botBId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bot_channel_messages" ADD CONSTRAINT "bot_channel_messages_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "bot_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "bot_channels" ADD CONSTRAINT "bot_channels_distinct_bots_check" CHECK ("botAId" <> "botBId");
