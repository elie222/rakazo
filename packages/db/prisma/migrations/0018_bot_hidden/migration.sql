-- Hiding a bot only removes it from the sidebar. Archiving stays the heavier action that
-- stops runs and disables routines, so the two flags are deliberately independent.
ALTER TABLE "bots" ADD COLUMN "hidden" BOOLEAN NOT NULL DEFAULT false;
