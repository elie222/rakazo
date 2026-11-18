-- Additive: older releases never read or write it.
ALTER TABLE "connections" ADD COLUMN "verbatimResults" BOOLEAN NOT NULL DEFAULT false;
