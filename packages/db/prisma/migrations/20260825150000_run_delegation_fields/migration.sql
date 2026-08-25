-- A run created by an @mention delegation from another bot's own thread
-- tracks that origin so its status can be mirrored back into a live card
-- there. Plain columns, no foreign key: the origin thread/message can
-- belong to a different bot than this run's own.
ALTER TABLE "runs" ADD COLUMN "delegatedFromThreadId" TEXT;
ALTER TABLE "runs" ADD COLUMN "delegatedFromMessageId" TEXT;
