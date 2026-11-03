-- One saved cloud-agent key per user. The ciphertext column stores a secret-store
-- reference bound to the row id, the same way payment wallets do.

CREATE TABLE "cloud_agent_credentials" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cloud_agent_credentials_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "cloud_agent_credentials_userId_key" ON "cloud_agent_credentials"("userId");
CREATE INDEX "cloud_agent_credentials_providerKey_idx" ON "cloud_agent_credentials"("providerKey");

ALTER TABLE "cloud_agent_credentials" ADD CONSTRAINT "cloud_agent_credentials_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "cloud_agent_credentials" ENABLE ROW LEVEL SECURITY;
CREATE POLICY cloud_agent_credentials_tenant ON "cloud_agent_credentials"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY cloud_agent_credentials_system ON "cloud_agent_credentials"
  USING ((SELECT app_rls_bypass()));
