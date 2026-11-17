-- Any member of a page's Space may read a page its owner shared with the Space (or by link),
-- and only its current version. Reads only: writes still go through pages_tenant, the owner's.
CREATE POLICY pages_space_read ON "pages" FOR SELECT
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '')
     AND "visibility" IN ('space', 'link'));

CREATE POLICY page_versions_space_read ON "page_versions" FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM "pages" p
    WHERE p."id" = "page_versions"."pageId"
      AND p."spaceId" = NULLIF(current_setting('app.space_id', true), '')
      AND p."visibility" IN ('space', 'link')
      AND p."currentVersion" = "page_versions"."version"
  ));

CREATE INDEX "pages_spaceId_visibility_updatedAt_idx" ON "pages"("spaceId", "visibility", "updatedAt");
