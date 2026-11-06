-- Sole statement so CREATE INDEX CONCURRENTLY runs outside an implicit
-- transaction. Each inbound chat-app text reads its conversation's newest row.
CREATE INDEX CONCURRENTLY "messaging_outbound_identityId_createdAt_idx" ON "messaging_outbound" ("identityId", "createdAt");
