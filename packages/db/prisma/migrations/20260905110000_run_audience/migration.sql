-- Existing runs may already contain mixed private/group context. Do not infer
-- an outbound audience from their original source message during migration.
ALTER TABLE "runs" ADD COLUMN "audience" TEXT;
ALTER TABLE "messages" ADD COLUMN "audience" TEXT;

-- Do not retry already queued replies from unbound legacy runs. Invitations
-- and other control messages have no source message and remain deliverable.
UPDATE "messaging_outbound" SET "status" = 'failed'
WHERE "status" = 'pending' AND "sourceMessageId" IS NOT NULL;
