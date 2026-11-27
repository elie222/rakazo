CREATE TABLE "organization_model_connections" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "organizationId" TEXT NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "provider" TEXT NOT NULL,
  "modelId" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "secretId" TEXT NOT NULL,
  "ciphertext" TEXT NOT NULL,
  "supportsImages" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "organization_model_connections_organizationId_createdAt_idx"
  ON "organization_model_connections"("organizationId", "createdAt");

ALTER TABLE "organization_model_connections" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "organization_model_connections_system" ON "organization_model_connections"
  USING ((SELECT app_rls_bypass()));
