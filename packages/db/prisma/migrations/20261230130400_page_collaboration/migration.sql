CREATE TABLE "page_grants" (
  "id" TEXT PRIMARY KEY,
  "pageId" TEXT NOT NULL REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "recipientEmail" TEXT NOT NULL,
  "userId" TEXT REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "bound" BOOLEAN NOT NULL DEFAULT false,
  "firstVersion" INTEGER NOT NULL
);
CREATE UNIQUE INDEX "page_grants_pageId_recipientEmail_key" ON "page_grants"("pageId", "recipientEmail");
CREATE INDEX "page_grants_userId_pageId_idx" ON "page_grants"("userId", "pageId");

CREATE TABLE "page_comments" (
  "id" TEXT PRIMARY KEY,
  "pageId" TEXT NOT NULL REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "authorId" TEXT REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "version" INTEGER NOT NULL,
  "section" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3)
);
CREATE INDEX "page_comments_pageId_createdAt_id_idx" ON "page_comments"("pageId", "createdAt", "id");

CREATE TABLE "page_revision_requests" (
  "id" TEXT PRIMARY KEY,
  "commentId" TEXT NOT NULL REFERENCES "page_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "retryOf" TEXT,
  "requesterId" TEXT NOT NULL,
  "grantId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "draftSource" TEXT,
  "draftCode" TEXT,
  "resultVersion" INTEGER
);
CREATE UNIQUE INDEX "page_revision_requests_retryOf_key" ON "page_revision_requests"("retryOf");
CREATE INDEX "page_revision_requests_commentId_createdAt_idx" ON "page_revision_requests"("commentId", "createdAt");
CREATE INDEX "page_revision_requests_grantId_idx" ON "page_revision_requests"("grantId");

-- Collaboration crosses Space boundaries exclusively through page-scoped service methods.
ALTER TABLE "page_grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "page_comments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "page_revision_requests" ENABLE ROW LEVEL SECURITY;
CREATE POLICY page_grants_system ON "page_grants" USING ((SELECT app_rls_bypass()));
CREATE POLICY page_comments_system ON "page_comments" USING ((SELECT app_rls_bypass()));
CREATE POLICY page_revision_requests_system ON "page_revision_requests" USING ((SELECT app_rls_bypass()));
