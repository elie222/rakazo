ALTER TABLE "threads"
  ADD COLUMN "lastReadSeq" INTEGER NOT NULL DEFAULT -1,
  ADD COLUMN "lastUnreadSeq" INTEGER NOT NULL DEFAULT -1;

-- The old boolean cannot recover a historic read boundary. Existing read chats
-- start at their current head; unread chats conservatively expose the latest
-- incoming message as new rather than labelling their entire history unread.
WITH positions AS (
  SELECT t.id, t.unread, t."nextMessageSeq" - 1 AS head,
    COALESCE(MAX(m.seq) FILTER (WHERE m.role = 'bot'), -1) AS incoming
  FROM "threads" t
  LEFT JOIN "messages" m ON m."threadId" = t.id
  GROUP BY t.id
)
UPDATE "threads" t
SET "lastReadSeq" = CASE
      WHEN p.unread AND p.incoming >= 0 THEN p.incoming - 1
      ELSE p.head
    END,
    "lastUnreadSeq" = p.incoming
FROM positions p
WHERE t.id = p.id;
