CREATE TABLE "bot_connector_defaults" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "connectorId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "bot_connector_defaults_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "bot_connector_defaults_botId_connectorId_provider_key"
  ON "bot_connector_defaults"("botId", "connectorId", "provider");
CREATE INDEX "bot_connector_defaults_workspaceId_userId_botId_idx"
  ON "bot_connector_defaults"("workspaceId", "userId", "botId");
CREATE INDEX "bot_connector_defaults_connectionId_idx"
  ON "bot_connector_defaults"("connectionId");

ALTER TABLE "bot_connector_defaults"
  ADD CONSTRAINT "bot_connector_defaults_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bot_connector_defaults"
  ADD CONSTRAINT "bot_connector_defaults_botId_fkey"
  FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bot_connector_defaults"
  ADD CONSTRAINT "bot_connector_defaults_connectionId_fkey"
  FOREIGN KEY ("connectionId") REFERENCES "connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
