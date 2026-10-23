-- Sole statement in this migration so it runs outside an implicit
-- transaction: CREATE INDEX CONCURRENTLY errors inside one, and only
-- applies concurrently as a top-level statement (see prior migration).
CREATE INDEX CONCURRENTLY "external_messages_externalConversationId_senderIsBot_create_idx" ON "external_messages"("externalConversationId", "senderIsBot", "createdAt");
