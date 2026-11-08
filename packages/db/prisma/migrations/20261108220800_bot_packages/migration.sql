CREATE TABLE "bot_package_previews" (
  "id" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "digest" TEXT NOT NULL,
  "sourceFormat" TEXT NOT NULL,
  "document" JSONB NOT NULL,
  "leftOut" JSONB NOT NULL,
  "includeMemory" BOOLEAN NOT NULL DEFAULT false,
  "availableMemoryCount" INTEGER NOT NULL DEFAULT 0,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "bot_package_previews_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "bot_package_previews_tokenHash_key" ON "bot_package_previews"("tokenHash");
CREATE INDEX "bot_package_previews_spaceId_userId_expiresAt_idx" ON "bot_package_previews"("spaceId", "userId", "expiresAt");
CREATE INDEX "bot_package_previews_expiresAt_id_idx" ON "bot_package_previews"("expiresAt", "id");
ALTER TABLE "bot_package_previews" ADD CONSTRAINT "bot_package_previews_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bot_package_previews" ADD CONSTRAINT "bot_package_previews_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "bot_package_imports" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "clientNonce" TEXT NOT NULL,
  "previewTokenHash" TEXT,
  "digest" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT 'importing',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "botId" TEXT,
  "botName" TEXT NOT NULL DEFAULT '',
  "plan" JSONB,
  "leftOut" JSONB NOT NULL DEFAULT '[]',
  "skillCount" INTEGER NOT NULL DEFAULT 0,
  "connectionCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "bot_package_imports_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "bot_package_imports_previewTokenHash_key" ON "bot_package_imports"("previewTokenHash");
CREATE UNIQUE INDEX "bot_package_imports_botId_key" ON "bot_package_imports"("botId");
CREATE UNIQUE INDEX "bot_package_imports_spaceId_userId_clientNonce_key" ON "bot_package_imports"("spaceId", "userId", "clientNonce");
CREATE INDEX "bot_package_imports_spaceId_userId_createdAt_idx" ON "bot_package_imports"("spaceId", "userId", "createdAt");
ALTER TABLE "bot_package_imports" ADD CONSTRAINT "bot_package_imports_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bot_package_imports" ADD CONSTRAINT "bot_package_imports_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bot_package_imports" ADD CONSTRAINT "bot_package_imports_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "bot_package_components" (
  "id" TEXT NOT NULL,
  "importId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "content" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "targetSkillId" TEXT,
  "activationBinding" TEXT,
  CONSTRAINT "bot_package_components_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "bot_package_components_importId_key_key" ON "bot_package_components"("importId", "key");
CREATE INDEX "bot_package_components_botId_idx" ON "bot_package_components"("botId");
ALTER TABLE "bot_package_components" ADD CONSTRAINT "bot_package_components_importId_fkey" FOREIGN KEY ("importId") REFERENCES "bot_package_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bot_package_components" ADD CONSTRAINT "bot_package_components_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security, following the tenant/system shape of the other
-- Space-owned tables. Previews and imports carry their own spaceId;
-- components resolve their Space through the import and the bot.
ALTER TABLE "bot_package_previews" ENABLE ROW LEVEL SECURITY;
CREATE POLICY bot_package_previews_tenant ON "bot_package_previews"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY bot_package_previews_system ON "bot_package_previews"
  USING ((SELECT app_rls_bypass()));

ALTER TABLE "bot_package_imports" ENABLE ROW LEVEL SECURITY;
CREATE POLICY bot_package_imports_tenant ON "bot_package_imports"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY bot_package_imports_system ON "bot_package_imports"
  USING ((SELECT app_rls_bypass()));

ALTER TABLE "bot_package_components" ENABLE ROW LEVEL SECURITY;
CREATE POLICY bot_package_components_tenant ON "bot_package_components"
  USING (
    EXISTS (
      SELECT 1 FROM "bot_package_imports" i
      WHERE i."id" = "bot_package_components"."importId"
        AND i."spaceId" = NULLIF(current_setting('app.space_id', true), '')
    )
    AND EXISTS (
      SELECT 1 FROM "bots" b
      WHERE b."id" = "bot_package_components"."botId"
        AND b."spaceId" = NULLIF(current_setting('app.space_id', true), '')
    )
  );
CREATE POLICY bot_package_components_system ON "bot_package_components"
  USING ((SELECT app_rls_bypass()));
