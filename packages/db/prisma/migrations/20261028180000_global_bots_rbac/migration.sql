-- Global bots catalog, connectors, space enablement, and role permissions.
-- Also break Bot↔Thread 1:1 so shared Global instances can have one thread per user.

-- AlterTable
ALTER TABLE "bots" ADD COLUMN "globalBotId" TEXT;
ALTER TABLE "bots" ALTER COLUMN "userId" DROP NOT NULL;

-- DropIndex
DROP INDEX IF EXISTS "threads_botId_key";

-- CreateTable
CREATE TABLE "global_bots" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "instructions" TEXT NOT NULL DEFAULT '',
    "color" TEXT NOT NULL,
    "modelProvider" TEXT,
    "modelId" TEXT,
    "thinkingLevel" TEXT,
    "disabledBuiltinTools" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "global_bots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connectors" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "skillRefs" JSONB NOT NULL DEFAULT '[]',
    "mcpConfig" JSONB NOT NULL DEFAULT '{}',
    "version" TEXT NOT NULL DEFAULT '1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connectors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "global_bot_connectors" (
    "globalBotId" TEXT NOT NULL,
    "connectorId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "global_bot_connectors_pkey" PRIMARY KEY ("globalBotId","connectorId")
);

-- CreateTable
CREATE TABLE "space_global_bots" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "globalBotId" TEXT NOT NULL,
    "enabledByUserId" TEXT,
    "enabledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "space_global_bots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "space_role_permissions" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "space_role_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "global_bots_slug_key" ON "global_bots"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "connectors_slug_key" ON "connectors"("slug");

-- CreateIndex
CREATE INDEX "global_bot_connectors_connectorId_idx" ON "global_bot_connectors"("connectorId");

-- CreateIndex
CREATE UNIQUE INDEX "space_global_bots_spaceId_globalBotId_key" ON "space_global_bots"("spaceId", "globalBotId");

-- CreateIndex
CREATE INDEX "space_global_bots_spaceId_idx" ON "space_global_bots"("spaceId");

-- CreateIndex
CREATE INDEX "space_global_bots_globalBotId_idx" ON "space_global_bots"("globalBotId");

-- CreateIndex
CREATE UNIQUE INDEX "space_role_permissions_spaceId_role_permission_key" ON "space_role_permissions"("spaceId", "role", "permission");

-- CreateIndex
CREATE INDEX "space_role_permissions_spaceId_role_idx" ON "space_role_permissions"("spaceId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "bots_spaceId_globalBotId_key" ON "bots"("spaceId", "globalBotId");

-- CreateIndex
CREATE INDEX "bots_globalBotId_idx" ON "bots"("globalBotId");

-- CreateIndex
CREATE UNIQUE INDEX "threads_botId_userId_key" ON "threads"("botId", "userId");

-- CreateIndex
CREATE INDEX "threads_botId_userId_idx" ON "threads"("botId", "userId");

-- AddForeignKey
ALTER TABLE "bots" ADD CONSTRAINT "bots_globalBotId_fkey" FOREIGN KEY ("globalBotId") REFERENCES "global_bots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "global_bot_connectors" ADD CONSTRAINT "global_bot_connectors_globalBotId_fkey" FOREIGN KEY ("globalBotId") REFERENCES "global_bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "global_bot_connectors" ADD CONSTRAINT "global_bot_connectors_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "space_global_bots" ADD CONSTRAINT "space_global_bots_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "space_global_bots" ADD CONSTRAINT "space_global_bots_globalBotId_fkey" FOREIGN KEY ("globalBotId") REFERENCES "global_bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "space_role_permissions" ADD CONSTRAINT "space_role_permissions_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
