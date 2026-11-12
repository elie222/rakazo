ALTER TABLE "mcp_servers" ADD COLUMN "deploymentAppId" TEXT;
CREATE UNIQUE INDEX "mcp_servers_userId_deploymentAppId_key" ON "mcp_servers"("userId", "deploymentAppId");
