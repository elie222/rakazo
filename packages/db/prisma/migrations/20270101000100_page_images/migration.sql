ALTER TABLE "page_versions" ADD COLUMN "images" JSONB;

CREATE TABLE "page_images" (
    "id" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "size" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "page_images_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "page_images_pageId_hash_key" ON "page_images"("pageId", "hash");

ALTER TABLE "page_images" ADD CONSTRAINT "page_images_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A page's pictures follow the page: its owner as tenant, everything else a named system read.
ALTER TABLE "page_images" ENABLE ROW LEVEL SECURITY;
CREATE POLICY page_images_tenant ON "page_images"
  USING (EXISTS (
    SELECT 1 FROM "pages" p
    WHERE p."id" = "page_images"."pageId"
      AND p."spaceId" = NULLIF(current_setting('app.space_id', true), '')
      AND p."userId" = NULLIF(current_setting('app.user_id', true), '')
  ));
CREATE POLICY page_images_system ON "page_images"
  USING ((SELECT app_rls_bypass()));
