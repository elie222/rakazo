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
    "sourceRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_channel_messages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "bot_channels_workspaceId_botAId_botBId_key" ON "bot_channels"("workspaceId", "botAId", "botBId");
CREATE INDEX "bot_channels_workspaceId_idx" ON "bot_channels"("workspaceId");
CREATE INDEX "bot_channel_messages_channelId_createdAt_idx" ON "bot_channel_messages"("channelId", "createdAt");

ALTER TABLE "bot_channels" ADD CONSTRAINT "bot_channels_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bot_channel_messages" ADD CONSTRAINT "bot_channel_messages_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "bot_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
