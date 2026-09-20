-- Lets an artifact carry version history: every row is a version, a root
-- row (rootArtifactId IS NULL) is the stable identity a family is addressed
-- by, and later versions point back at it. Deleting a root cascades to every
-- version, so removing a family from the Artifacts tab is one delete.
ALTER TABLE "artifacts" ADD COLUMN "rootArtifactId" TEXT;
ALTER TABLE "artifacts" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "artifacts"
  ADD CONSTRAINT "artifacts_rootArtifactId_fkey"
  FOREIGN KEY ("rootArtifactId") REFERENCES "artifacts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "artifacts_rootArtifactId_idx" ON "artifacts"("rootArtifactId");
