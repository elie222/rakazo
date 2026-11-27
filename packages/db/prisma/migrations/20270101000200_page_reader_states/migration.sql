CREATE TABLE "page_reader_states" (
  "id" TEXT PRIMARY KEY,
  "pageId" TEXT NOT NULL REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "spaceId" TEXT NOT NULL,
  "values" JSONB NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "page_reader_states_pageId_userId_key" ON "page_reader_states"("pageId", "userId");
CREATE INDEX "page_reader_states_userId_idx" ON "page_reader_states"("userId");

ALTER TABLE "page_reader_states" ENABLE ROW LEVEL SECURITY;
CREATE POLICY page_reader_states_system ON "page_reader_states" USING ((SELECT app_rls_bypass()));
