-- Build the index separately so existing chats can keep writing during the scan.
CREATE INDEX CONCURRENTLY "messages_thread_pins_idx"
ON "messages" ("threadId", "pinnedAt" DESC, "seq" DESC)
WHERE "pinnedAt" IS NOT NULL;
