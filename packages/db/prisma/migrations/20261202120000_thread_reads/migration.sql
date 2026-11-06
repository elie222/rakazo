-- Each member's own read state for a chat, a personal resource (userId, spaceId). Additive:
-- the previous release keeps writing threads.unread and threads."lastReadSeq" while it runs;
-- 20261202120100_drop_thread_unread drops them once it has stopped.

CREATE TABLE "thread_reads" (
    "threadId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "unread" BOOLEAN NOT NULL DEFAULT false,
    "lastReadSeq" INTEGER NOT NULL DEFAULT -1,

    CONSTRAINT "thread_reads_pkey" PRIMARY KEY ("threadId", "userId")
);

CREATE INDEX "thread_reads_spaceId_userId_idx" ON "thread_reads"("spaceId", "userId");

ALTER TABLE "thread_reads" ADD CONSTRAINT "thread_reads_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Leaving a Space deletes the membership, and with it the person's read state there.
ALTER TABLE "thread_reads" ADD CONSTRAINT "thread_reads_spaceId_userId_fkey" FOREIGN KEY ("spaceId", "userId") REFERENCES "space_members"("spaceId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- No row reads as caught up, so only unread chats need one. Every member starts from the state
-- they all shared until now.
INSERT INTO "thread_reads" ("threadId", "userId", "spaceId", "unread", "lastReadSeq")
SELECT t."id", m."userId", t."spaceId", true, t."lastReadSeq"
FROM "threads" t
JOIN "space_members" m ON m."spaceId" = t."spaceId"
WHERE t."unread";

-- A member's own rows. Marking a chat unread for the other members is a named system step.
ALTER TABLE "thread_reads" ENABLE ROW LEVEL SECURITY;
CREATE POLICY thread_reads_tenant ON "thread_reads"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '')
     AND "userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY thread_reads_system ON "thread_reads"
  USING ((SELECT app_rls_bypass()));

-- The previous release marks a chat unread on the thread only. While it finishes its runs, a
-- reply it writes marks the chat unread for every member, as before.
CREATE FUNCTION thread_reads_mirror_unread() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
  AS $$
BEGIN
  INSERT INTO "thread_reads" ("threadId", "userId", "spaceId", "unread", "lastReadSeq")
  SELECT NEW."id", m."userId", NEW."spaceId", true, NEW."lastReadSeq"
  FROM "space_members" m
  WHERE m."spaceId" = NEW."spaceId"
  ON CONFLICT ("threadId", "userId") DO UPDATE SET "unread" = true;
  RETURN NEW;
END $$;
CREATE TRIGGER threads_mirror_unread AFTER UPDATE OF "unread" ON "threads"
  FOR EACH ROW WHEN (NEW."unread") EXECUTE FUNCTION thread_reads_mirror_unread();
