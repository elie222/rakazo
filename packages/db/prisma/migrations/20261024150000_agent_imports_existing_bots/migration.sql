-- An import can now add to an existing bot, so one bot can have several imports. Only an
-- index changes: the previous release reads rows by botId and still finds them.
DROP INDEX "agent_imports_botId_key";
CREATE INDEX "agent_imports_botId_createdAt_idx" ON "agent_imports"("botId", "createdAt");
