-- Additive: legacy bot behavior remains unchanged until a profile is written.
CREATE TABLE "bot_runtime_profiles" (
    "botId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "settings" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bot_runtime_profiles_pkey" PRIMARY KEY ("botId"),
    CONSTRAINT "bot_runtime_profiles_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "bot_runtime_profile_revisions" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "settings" JSONB NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_runtime_profile_revisions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "bot_runtime_profile_revisions_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bot_runtime_profiles"("botId") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "bot_runtime_profile_revisions_botId_revision_key" ON "bot_runtime_profile_revisions"("botId", "revision");
CREATE INDEX "bot_runtime_profile_revisions_actorUserId_createdAt_idx" ON "bot_runtime_profile_revisions"("actorUserId", "createdAt");

CREATE OR REPLACE FUNCTION app_rls_version() RETURNS integer
  LANGUAGE sql STABLE
  AS $$ SELECT COALESCE(NULLIF(current_setting('app.rls_version', true), ''), '0')::integer $$;

ALTER TABLE "bot_runtime_profiles" ENABLE ROW LEVEL SECURITY;
CREATE POLICY bot_runtime_profiles_system ON "bot_runtime_profiles"
  USING (current_setting('app.rls_bypass', true) = 'on');
CREATE POLICY bot_runtime_profiles_tenant ON "bot_runtime_profiles"
  USING (EXISTS (
    SELECT 1 FROM "bots" b
    WHERE b."id" = "bot_runtime_profiles"."botId"
      AND b."spaceId" = NULLIF(current_setting('app.space_id', true), '')
      AND b."userId" = NULLIF(current_setting('app.user_id', true), '')
  ));

ALTER TABLE "bot_runtime_profile_revisions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY bot_runtime_profile_revisions_system ON "bot_runtime_profile_revisions"
  USING (current_setting('app.rls_bypass', true) = 'on');
CREATE POLICY bot_runtime_profile_revisions_tenant ON "bot_runtime_profile_revisions"
  USING (EXISTS (
    SELECT 1 FROM "bot_runtime_profiles" p
    JOIN "bots" b ON b."id" = p."botId"
    WHERE p."botId" = "bot_runtime_profile_revisions"."botId"
      AND b."spaceId" = NULLIF(current_setting('app.space_id', true), '')
      AND b."userId" = NULLIF(current_setting('app.user_id', true), '')
  ));

CREATE FUNCTION bot_runtime_profile_revisions_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Bot runtime profile revisions are append-only';
END $$;
CREATE TRIGGER bot_runtime_profile_revisions_no_update
  BEFORE UPDATE OR TRUNCATE ON "bot_runtime_profile_revisions"
  FOR EACH STATEMENT EXECUTE FUNCTION bot_runtime_profile_revisions_append_only();
REVOKE UPDATE, DELETE, TRUNCATE ON "bot_runtime_profile_revisions" FROM rakazo_app;
