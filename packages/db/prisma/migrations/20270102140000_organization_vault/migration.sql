CREATE TABLE "organization_logins" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "name" TEXT NOT NULL,
  "origin" TEXT NOT NULL
);
CREATE INDEX "organization_logins_organizationId_idx" ON "organization_logins"("organizationId");

CREATE TABLE "organization_login_grants" (
  "loginId" TEXT NOT NULL REFERENCES "organization_logins"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "botId" TEXT NOT NULL REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  PRIMARY KEY ("loginId", "botId")
);
CREATE INDEX "organization_login_grants_botId_idx" ON "organization_login_grants"("botId");

ALTER TABLE "organization_logins" ENABLE ROW LEVEL SECURITY;
CREATE POLICY organization_logins_system ON "organization_logins" USING ((SELECT app_rls_bypass()));
ALTER TABLE "organization_login_grants" ENABLE ROW LEVEL SECURITY;
CREATE POLICY organization_login_grants_system ON "organization_login_grants" USING ((SELECT app_rls_bypass()));
