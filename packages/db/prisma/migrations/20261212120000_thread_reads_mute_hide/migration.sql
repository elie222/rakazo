-- A member's own mute and hide for a chat. Additive; the previous release never reads them.
-- A null mute means the member never chose, so a bot's own notification setting still decides.
ALTER TABLE "thread_reads" ADD COLUMN "muted" BOOLEAN;
ALTER TABLE "thread_reads" ADD COLUMN "hidden" BOOLEAN NOT NULL DEFAULT false;
