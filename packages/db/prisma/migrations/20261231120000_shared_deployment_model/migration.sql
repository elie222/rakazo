CREATE TABLE "deployment_model_connections" (
  "id" TEXT PRIMARY KEY DEFAULT 'default' CHECK ("id" = 'default'),
  "provider" TEXT,
  "modelId" TEXT,
  "method" TEXT,
  "revision" TEXT,
  "credentialCipher" TEXT,
  "disabled" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "deployment_model_connection_complete" CHECK (
    ("provider" IS NULL AND "modelId" IS NULL AND "method" IS NULL AND "credentialCipher" IS NULL)
    OR
    ("provider" IS NOT NULL AND "modelId" IS NOT NULL AND "method" IS NOT NULL
      AND "method" IN ('api_key', 'oauth') AND "revision" IS NOT NULL AND "credentialCipher" IS NOT NULL)
  )
);

ALTER TABLE "deployment_model_connections" ENABLE ROW LEVEL SECURITY;
CREATE POLICY deployment_model_connections_system ON "deployment_model_connections"
  USING ((SELECT app_rls_bypass()));
GRANT SELECT, INSERT, UPDATE, DELETE ON "deployment_model_connections" TO rakazo_app;
