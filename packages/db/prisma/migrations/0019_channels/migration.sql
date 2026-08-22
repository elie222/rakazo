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
    "sourceEffectId" TEXT,
    "clientNonce" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_messages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "channels_workspaceId_userId_name_key" ON "channels"("workspaceId", "userId", "name");
CREATE INDEX "channels_workspaceId_userId_updatedAt_idx" ON "channels"("workspaceId", "userId", "updatedAt");
CREATE UNIQUE INDEX "channel_members_channelId_botId_key" ON "channel_members"("channelId", "botId");
CREATE INDEX "channel_members_botId_idx" ON "channel_members"("botId");
CREATE UNIQUE INDEX "channel_messages_channelId_userId_clientNonce_key" ON "channel_messages"("channelId", "userId", "clientNonce");
CREATE UNIQUE INDEX "channel_messages_channelId_sourceEffectId_key" ON "channel_messages"("channelId", "sourceEffectId");
CREATE INDEX "channel_messages_channelId_createdAt_id_idx" ON "channel_messages"("channelId", "createdAt", "id");
CREATE INDEX "channel_messages_sourceRunId_idx" ON "channel_messages"("sourceRunId");

ALTER TABLE "runs" ADD COLUMN "channelId" TEXT;
ALTER TABLE "runs" ADD COLUMN "channelMessageId" TEXT;
CREATE INDEX "runs_channelId_status_idx" ON "runs"("channelId", "status");
CREATE INDEX "runs_channelMessageId_idx" ON "runs"("channelMessageId");

ALTER TABLE "channels" ADD CONSTRAINT "channels_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "channels" ADD CONSTRAINT "channels_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "channel_members" ADD CONSTRAINT "channel_members_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "channel_members" ADD CONSTRAINT "channel_members_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_authorBotId_fkey" FOREIGN KEY ("authorBotId") REFERENCES "bots"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "runs" ADD CONSTRAINT "runs_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channels"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "runs" ADD CONSTRAINT "runs_channelMessageId_fkey" FOREIGN KEY ("channelMessageId") REFERENCES "channel_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_author_shape_check" CHECK (
    ("authorType" = 'user' AND "authorBotId" IS NULL AND "userId" IS NOT NULL AND "clientNonce" IS NOT NULL AND "sourceRunId" IS NULL AND "sourceEffectId" IS NULL)
    OR
    ("authorType" = 'bot' AND "userId" IS NULL AND "clientNonce" IS NULL AND "sourceRunId" IS NOT NULL AND "sourceEffectId" IS NOT NULL)
);
