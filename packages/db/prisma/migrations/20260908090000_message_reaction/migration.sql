BEGIN;
-- Preserve existing thumbs-ups as ordinary emoji replies before removing mutable reaction state.
WITH ranked AS MATERIALIZED (
  SELECT id, "threadId", row_number() OVER (PARTITION BY "threadId" ORDER BY seq) AS position
  FROM "messages" WHERE "thumbsUp" = true
), allocated AS (
  UPDATE "threads" AS thread
  SET "nextMessageSeq" = thread."nextMessageSeq" + counts.total
  FROM (SELECT "threadId", count(*)::integer AS total FROM ranked GROUP BY "threadId") AS counts
  WHERE thread.id = counts."threadId"
  RETURNING thread.id, thread."nextMessageSeq" - counts.total AS start_seq
)
INSERT INTO "messages" (id, "threadId", seq, role, blocks, "replyToMessageId", "createdAt")
SELECT 'reaction-' || ranked.id, ranked."threadId", allocated.start_seq + ranked.position - 1,
  'user', '[{"kind":"text","text":"👍"}]'::jsonb, ranked.id, CURRENT_TIMESTAMP
FROM ranked JOIN allocated ON allocated.id = ranked."threadId";
ALTER TABLE "messages" DROP COLUMN "thumbsUp";
COMMIT;
