-- Reuse messages_history_search_idx: its GIN expression already matches history retrieval.
-- Build outside a transaction so existing chats remain writable.
CREATE INDEX CONCURRENTLY "threads_spaceId_userId_idx" ON "threads" ("spaceId", "userId");
