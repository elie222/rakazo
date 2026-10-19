-- Link plugin capability installs to the rows they create so uninstall can
-- cascade (skills + MCP servers created by a plugin install).

ALTER TABLE "agent_skills" ADD COLUMN "installId" TEXT;
ALTER TABLE "mcp_servers" ADD COLUMN "installId" TEXT;

ALTER TABLE "agent_skills"
  ADD CONSTRAINT "agent_skills_installId_fkey"
  FOREIGN KEY ("installId") REFERENCES "capability_installs"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "mcp_servers"
  ADD CONSTRAINT "mcp_servers_installId_fkey"
  FOREIGN KEY ("installId") REFERENCES "capability_installs"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "agent_skills_installId_idx" ON "agent_skills"("installId");
CREATE INDEX "mcp_servers_installId_idx" ON "mcp_servers"("installId");
