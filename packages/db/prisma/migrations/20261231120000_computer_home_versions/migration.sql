CREATE TABLE "computer_home_versions" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "computerId" TEXT NOT NULL REFERENCES "computers"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "storageId" TEXT NOT NULL,
  "revision" TEXT NOT NULL,
  "savedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "computer_home_versions_storageId_revision_key"
  ON "computer_home_versions"("storageId", "revision");
CREATE INDEX "computer_home_versions_computerId_savedAt_idx"
  ON "computer_home_versions"("computerId", "savedAt");
ALTER TABLE "computer_home_versions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY computer_home_versions_system ON "computer_home_versions"
  USING ((SELECT app_rls_bypass()));
