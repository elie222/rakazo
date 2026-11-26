-- An organization can own MCP servers and their secrets. Such a row has no member or Space:
-- leaving the organization or deleting the Space it was added from keeps it.
ALTER TABLE "mcp_servers" ALTER COLUMN "spaceId" DROP NOT NULL;
ALTER TABLE "mcp_servers" ALTER COLUMN "userId" DROP NOT NULL;
ALTER TABLE "mcp_servers" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_organizationId_fkey" FOREIGN KEY ("organizationId")
  REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_owner_check" CHECK (
  ("organizationId" IS NULL AND "userId" IS NOT NULL AND "spaceId" IS NOT NULL)
  OR ("organizationId" IS NOT NULL AND "userId" IS NULL AND "spaceId" IS NULL)
);
CREATE UNIQUE INDEX "mcp_servers_organizationId_slug_key" ON "mcp_servers"("organizationId", "slug");

ALTER TABLE "secrets" ALTER COLUMN "userId" DROP NOT NULL;
ALTER TABLE "secrets" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_organizationId_fkey" FOREIGN KEY ("organizationId")
  REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_owner_check" CHECK (
  ("organizationId" IS NULL AND "userId" IS NOT NULL)
  OR ("organizationId" IS NOT NULL AND "userId" IS NULL AND "spaceId" IS NULL)
);
CREATE INDEX "secrets_organizationId_idx" ON "secrets"("organizationId");

-- An organization's row is reachable from any of its Spaces by a member who is not a guest.
CREATE FUNCTION app_organization_item(organization_id text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM public."spaces" s
      JOIN public."member" m ON m."organizationId" = s."organizationId"
      WHERE s."id" = NULLIF(current_setting('app.space_id', true), '')
        AND s."organizationId" = organization_id
        AND m."userId" = NULLIF(current_setting('app.user_id', true), '')
        AND m."role" <> 'guest'
    )
  $$;
REVOKE EXECUTE ON FUNCTION app_organization_item(text) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_app') THEN
    GRANT EXECUTE ON FUNCTION app_organization_item(text) TO rakazo_app;
  END IF;
END $$;

CREATE POLICY mcp_servers_organization ON "mcp_servers"
  USING ("organizationId" IS NOT NULL AND app_organization_item("organizationId"));
CREATE POLICY secrets_organization ON "secrets"
  USING ("organizationId" IS NOT NULL AND app_organization_item("organizationId"));
