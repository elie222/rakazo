ALTER TABLE "connections" ALTER COLUMN "spaceId" DROP NOT NULL;
ALTER TABLE "connections" ALTER COLUMN "userId" DROP NOT NULL;
ALTER TABLE "connections" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "connections" ADD CONSTRAINT "connections_organizationId_fkey" FOREIGN KEY ("organizationId")
  REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "connections" ADD CONSTRAINT "connections_owner_check" CHECK (
  ("organizationId" IS NULL AND "userId" IS NOT NULL AND "spaceId" IS NOT NULL)
  OR ("organizationId" IS NOT NULL AND "userId" IS NULL AND "spaceId" IS NULL)
);
CREATE INDEX "connections_organizationId_idx" ON "connections"("organizationId");
CREATE UNIQUE INDEX "connections_organization_app_key"
  ON "connections" ("organizationId", lower("provider"))
  WHERE "organizationId" IS NOT NULL AND "status" <> 'revoked';
CREATE UNIQUE INDEX "connections_organization_name_key"
  ON "connections" ("organizationId", lower("displayName"))
  WHERE "organizationId" IS NOT NULL AND "status" <> 'revoked';

CREATE POLICY connections_organization ON "connections"
  USING ("organizationId" IS NOT NULL AND app_organization_item("organizationId"));
