-- Additive: the previous release never reads this table.
CREATE TABLE "tailnet_connections" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "botIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tailnet_connections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tailnet_connections_spaceId_userId_key" ON "tailnet_connections"("spaceId", "userId");

-- Leaving a Space deletes the membership, and with it the person's tailnet connection there.
ALTER TABLE "tailnet_connections" ADD CONSTRAINT "tailnet_connections_spaceId_userId_fkey" FOREIGN KEY ("spaceId", "userId") REFERENCES "space_members"("spaceId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- A member's own connection: other members of the Space can neither read nor use it.
ALTER TABLE "tailnet_connections" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tailnet_connections_tenant ON "tailnet_connections"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '')
     AND "userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY tailnet_connections_system ON "tailnet_connections"
  USING ((SELECT app_rls_bypass()));
