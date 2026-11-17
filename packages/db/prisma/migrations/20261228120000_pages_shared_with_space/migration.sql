-- Any member of a page's Space may read a page its owner shared with the Space, while the owner
-- is still a member, and only its current version. A page shared by link is not covered: its owner
-- gave the link to chosen people. Reads only: writes still go through pages_tenant, the owner's.
CREATE POLICY pages_space_read ON "pages" FOR SELECT
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '')
     AND "visibility" = 'space'
     AND EXISTS (
       SELECT 1 FROM "space_members" sm
       WHERE sm."spaceId" = "pages"."spaceId" AND sm."userId" = "pages"."userId"
     ));

CREATE POLICY page_versions_space_read ON "page_versions" FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM "pages" p
    WHERE p."id" = "page_versions"."pageId"
      AND p."spaceId" = NULLIF(current_setting('app.space_id', true), '')
      AND p."visibility" = 'space'
      AND p."currentVersion" = "page_versions"."version"
      AND EXISTS (
        SELECT 1 FROM "space_members" sm
        WHERE sm."spaceId" = p."spaceId" AND sm."userId" = p."userId"
      )
  ));

CREATE INDEX "pages_spaceId_visibility_updatedAt_idx" ON "pages"("spaceId", "visibility", "updatedAt");
