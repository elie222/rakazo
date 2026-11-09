-- CreateTable
CREATE TABLE "service_credentials" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "scopes" TEXT[],
    "botIds" TEXT[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "windowStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "windowCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_credentials_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "service_credentials_tokenHash_key" ON "service_credentials"("tokenHash");
CREATE INDEX "service_credentials_userId_spaceId_idx" ON "service_credentials"("userId", "spaceId");

ALTER TABLE "service_credentials" ADD CONSTRAINT "service_credentials_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "service_credentials" ADD CONSTRAINT "service_credentials_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A member reaches only their own credentials in the current space. Authentication runs as system.
ALTER TABLE "service_credentials" ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_credentials_tenant ON "service_credentials"
  USING (
    "userId" = NULLIF(current_setting('app.user_id', true), '')
    AND "spaceId" = NULLIF(current_setting('app.space_id', true), '')
  );
CREATE POLICY service_credentials_system ON "service_credentials"
  USING ((SELECT app_rls_bypass()));

-- CreateTable
CREATE TABLE "service_idempotency_keys" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "responseStatus" INTEGER,
    "responseBody" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_idempotency_keys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "service_idempotency_keys_credentialId_key_key" ON "service_idempotency_keys"("credentialId", "key");
CREATE INDEX "service_idempotency_keys_expiresAt_idx" ON "service_idempotency_keys"("expiresAt");

ALTER TABLE "service_idempotency_keys" ADD CONSTRAINT "service_idempotency_keys_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "service_credentials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "service_idempotency_keys" ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_idempotency_keys_tenant ON "service_idempotency_keys"
  USING (
    "userId" = NULLIF(current_setting('app.user_id', true), '')
    AND "spaceId" = NULLIF(current_setting('app.space_id', true), '')
  );
CREATE POLICY service_idempotency_keys_system ON "service_idempotency_keys"
  USING ((SELECT app_rls_bypass()));
