ALTER TABLE "pages" ADD COLUMN "icon" TEXT, ADD COLUMN "iconColor" TEXT;

CREATE TABLE "page_apps" (
  "id" TEXT PRIMARY KEY,
  "pageId" TEXT NOT NULL REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "spaceId" TEXT NOT NULL,
  "sessionId" TEXT,
  "tokenHash" TEXT NOT NULL,
  "abilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt" TIMESTAMP(3)
);
CREATE UNIQUE INDEX "page_apps_tokenHash_key" ON "page_apps"("tokenHash");
CREATE INDEX "page_apps_userId_idx" ON "page_apps"("userId");
CREATE INDEX "page_apps_pageId_idx" ON "page_apps"("pageId");
CREATE INDEX "page_apps_sessionId_idx" ON "page_apps"("sessionId");

ALTER TABLE "page_apps" ENABLE ROW LEVEL SECURITY;
CREATE POLICY page_apps_system ON "page_apps" USING ((SELECT app_rls_bypass()));
