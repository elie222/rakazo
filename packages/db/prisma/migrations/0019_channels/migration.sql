-- Named rooms shared by the user and any number of bots. Separate from bot_channels, which
-- is the implicit one-to-one transcript between two bots.
CREATE TABLE "channels" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channels_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "channel_members" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_members_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "channel_messages" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "authorType" TEXT NOT NULL,
    "authorBotId" TEXT,
    "userId" TEXT,
    "text" TEXT NOT NULL,
    "sourceRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_messages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "channels_workspaceId_userId_name_key" ON "channels"("workspaceId", "userId", "name");
CREATE INDEX "channels_workspaceId_userId_updatedAt_idx" ON "channels"("workspaceId", "userId", "updatedAt");
CREATE UNIQUE INDEX "channel_members_channelId_botId_key" ON "channel_members"("channelId", "botId");
CREATE INDEX "channel_members_botId_idx" ON "channel_members"("botId");
CREATE INDEX "channel_messages_channelId_createdAt_idx" ON "channel_messages"("channelId", "createdAt");

ALTER TABLE "channels" ADD CONSTRAINT "channels_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "channel_members" ADD CONSTRAINT "channel_members_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "channel_members" ADD CONSTRAINT "channel_members_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_authorBotId_fkey" FOREIGN KEY ("authorBotId") REFERENCES "bots"("id") ON DELETE SET NULL ON UPDATE CASCADE;
