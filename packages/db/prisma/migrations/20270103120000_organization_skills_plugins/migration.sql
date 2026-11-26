CREATE FUNCTION app_manage_organization_item(organization_id text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT public.app_organization_item(organization_id) AND EXISTS (
      SELECT 1 FROM public."member" m
      WHERE m."organizationId" = organization_id
        AND m."userId" = NULLIF(current_setting('app.user_id', true), '')
        AND EXISTS (
          SELECT 1 FROM unnest(string_to_array(m."role", ',')) AS role
          WHERE trim(role) IN ('owner', 'admin')
        )
    )
  $$;
REVOKE EXECUTE ON FUNCTION app_manage_organization_item(text) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_app') THEN
    GRANT EXECUTE ON FUNCTION app_manage_organization_item(text) TO rakazo_app;
  END IF;
END $$;

ALTER TABLE "agent_skills"
  ALTER COLUMN "spaceId" DROP NOT NULL,
  ALTER COLUMN "userId" DROP NOT NULL,
  ADD COLUMN "organizationId" TEXT REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_skills_ownership_check" CHECK (
    ("organizationId" IS NULL AND "spaceId" IS NOT NULL AND "userId" IS NOT NULL)
    OR ("organizationId" IS NOT NULL AND "spaceId" IS NULL AND "userId" IS NULL)
  );
CREATE INDEX "agent_skills_organizationId_idx" ON "agent_skills"("organizationId");
CREATE POLICY "agent_skills_organization_read" ON "agent_skills" FOR SELECT
  USING ("organizationId" IS NOT NULL AND app_organization_item("organizationId"));
CREATE POLICY "agent_skills_organization_manage" ON "agent_skills"
  USING ("organizationId" IS NOT NULL AND app_manage_organization_item("organizationId"));

ALTER TABLE "capability_installs"
  ALTER COLUMN "spaceId" DROP NOT NULL,
  ALTER COLUMN "userId" DROP NOT NULL,
  ADD COLUMN "organizationId" TEXT REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "capability_installs_ownership_check" CHECK (
    ("organizationId" IS NULL AND "spaceId" IS NOT NULL AND "userId" IS NOT NULL)
    OR ("organizationId" IS NOT NULL AND "spaceId" IS NULL AND "userId" IS NULL)
  );
CREATE INDEX "capability_installs_organizationId_idx" ON "capability_installs"("organizationId");
CREATE POLICY "capability_installs_organization_read" ON "capability_installs" FOR SELECT
  USING ("organizationId" IS NOT NULL AND app_organization_item("organizationId"));
CREATE POLICY "capability_installs_organization_manage" ON "capability_installs"
  USING ("organizationId" IS NOT NULL AND app_manage_organization_item("organizationId"));

CREATE UNIQUE INDEX "agent_skills_organization_name_key"
  ON "agent_skills" ("organizationId", lower("name")) WHERE "organizationId" IS NOT NULL;
CREATE UNIQUE INDEX "capability_installs_organization_plugin_source_key"
  ON "capability_installs" ("organizationId", "source")
  WHERE "organizationId" IS NOT NULL AND "kind" = 'plugin';
