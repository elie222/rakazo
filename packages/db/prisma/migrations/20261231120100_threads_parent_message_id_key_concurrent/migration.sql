-- Sole statement so CREATE INDEX CONCURRENTLY runs outside an implicit
-- transaction. Each message has at most one topic, and a chat's topics are found by it.
CREATE UNIQUE INDEX CONCURRENTLY "threads_parentMessageId_key" ON "threads" ("parentMessageId");
