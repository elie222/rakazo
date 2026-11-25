-- Additive: older releases never read this column and every page keeps posting updates.
ALTER TABLE "pages" ADD COLUMN "chatUpdates" BOOLEAN NOT NULL DEFAULT true;
