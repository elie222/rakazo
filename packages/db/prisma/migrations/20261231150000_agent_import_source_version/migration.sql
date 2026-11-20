-- Additive: the previous release never reads this column, and an import made before it
-- simply has no recorded version.
ALTER TABLE "agent_imports" ADD COLUMN "sourceVersion" INTEGER;
