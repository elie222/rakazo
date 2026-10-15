-- Expand-only: existing bots and queued runs retain the default Pi path.
CREATE TABLE "execution_profiles" (
  "id" TEXT NOT NULL,
  "seriesId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL CHECK ("revision" > 0),
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "harness" TEXT NOT NULL CHECK ("harness" IN ('pi', 'claude', 'codex', 'kimi')),
  "provider" TEXT NOT NULL,
  "credentialId" TEXT NOT NULL,
  "protocol" TEXT NOT NULL CHECK ("protocol" IN ('anthropic', 'openai-responses', 'openai-chat-completions')),
  "endpoint" TEXT,
  "modelId" TEXT NOT NULL,
  "runtimeVersion" TEXT NOT NULL,
  "computerId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "execution_profiles_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "execution_profiles_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "execution_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "execution_profiles_id_spaceId_userId_key" ON "execution_profiles"("id", "spaceId", "userId");
CREATE UNIQUE INDEX "execution_profiles_spaceId_userId_seriesId_revision_key" ON "execution_profiles"("spaceId", "userId", "seriesId", "revision");
CREATE INDEX "execution_profiles_spaceId_userId_createdAt_idx" ON "execution_profiles"("spaceId", "userId", "createdAt");
ALTER TABLE "bots" ADD COLUMN "executionProfileId" TEXT;
ALTER TABLE "bots" ADD CONSTRAINT "bots_executionProfileId_spaceId_userId_fkey" FOREIGN KEY ("executionProfileId", "spaceId", "userId") REFERENCES "execution_profiles"("id", "spaceId", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "runs" ADD COLUMN "executionProfileSnapshot" JSONB;

CREATE TABLE "native_harness_sessions" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "threadId" TEXT NOT NULL,
  "profileId" TEXT NOT NULL,
  "nativeSessionId" TEXT,
  "credentialSecretId" TEXT NOT NULL,
  "epoch" TEXT NOT NULL,
  "activeRunId" TEXT,
  "activeLeaseFence" INTEGER,
  "interruptedRunId" TEXT,
  "interrupted" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "native_harness_sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "native_harness_sessions_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "native_harness_sessions_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "native_harness_sessions_profileId_spaceId_userId_fkey" FOREIGN KEY ("profileId", "spaceId", "userId") REFERENCES "execution_profiles"("id", "spaceId", "userId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "native_harness_sessions_botId_threadId_profileId_key" ON "native_harness_sessions"("botId", "threadId", "profileId");
CREATE INDEX "native_harness_sessions_spaceId_userId_idx" ON "native_harness_sessions"("spaceId", "userId");

CREATE FUNCTION "reject_execution_profile_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Execution profile revisions are immutable; create a new revision';
END;
$$;
CREATE TRIGGER "execution_profiles_immutable" BEFORE UPDATE ON "execution_profiles"
FOR EACH ROW EXECUTE FUNCTION "reject_execution_profile_update"();

-- Covers every enqueue path, including routines, handoffs, messaging and steering.
-- Lock the bot row so concurrent binding changes have one unambiguous enqueue order.
CREATE FUNCTION "pin_run_execution_profile"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_bot RECORD;
  profile RECORD;
  credential RECORD;
  selected_computer TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."executionProfileSnapshot" IS DISTINCT FROM OLD."executionProfileSnapshot" THEN
      RAISE EXCEPTION 'Run execution profile snapshots are immutable';
    END IF;
    IF OLD."executionProfileSnapshot" IS NOT NULL AND (
      NEW."spaceId" IS DISTINCT FROM OLD."spaceId" OR NEW."userId" IS DISTINCT FROM OLD."userId" OR
      NEW."botId" IS DISTINCT FROM OLD."botId" OR NEW."threadId" IS DISTINCT FROM OLD."threadId"
    ) THEN RAISE EXCEPTION 'Pinned run ownership and conversation are immutable'; END IF;
    RETURN NEW;
  END IF;
  SELECT "executionProfileId", "computerId", "spaceId", "userId" INTO target_bot
    FROM "bots" WHERE "id" = NEW."botId" FOR SHARE;
  IF target_bot."executionProfileId" IS NULL THEN
    IF NEW."executionProfileSnapshot" IS NOT NULL THEN
      RAISE EXCEPTION 'An unbound bot cannot supply an execution profile snapshot';
    END IF;
    RETURN NEW;
  END IF;
  IF target_bot."spaceId" <> NEW."spaceId" OR target_bot."userId" <> NEW."userId" THEN
    RAISE EXCEPTION 'Execution profile scope mismatch';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "space_members" WHERE "spaceId" = NEW."spaceId" AND "userId" = NEW."userId") THEN
    RAISE EXCEPTION 'Execution profile membership unavailable';
  END IF;
  SELECT * INTO profile FROM "execution_profiles"
    WHERE "id" = target_bot."executionProfileId" AND "spaceId" = NEW."spaceId" AND "userId" = NEW."userId";
  IF NOT FOUND THEN RAISE EXCEPTION 'Execution profile unavailable'; END IF;
  IF NEW."modelPinned" AND (NEW."modelProvider" IS NOT NULL OR NEW."modelId" IS NOT NULL) THEN
    RAISE EXCEPTION 'Clear the model override to use the bot execution profile';
  END IF;
  SELECT "id", "secretId", "label" INTO credential FROM "user_model_credentials"
    WHERE "id" = profile."credentialId" AND "userId" = NEW."userId" AND "provider" = profile."provider" FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Execution profile credential disconnected'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "secrets" WHERE "id" = credential."secretId" AND "userId" = NEW."userId" AND "spaceId" IS NULL) THEN
    RAISE EXCEPTION 'Execution profile credential unavailable';
  END IF;
  selected_computer := COALESCE(profile."computerId", target_bot."computerId");
  IF selected_computer IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "computers" WHERE "id" = selected_computer AND "spaceId" = NEW."spaceId" AND "userId" = NEW."userId"
  ) THEN RAISE EXCEPTION 'Execution profile computer unavailable'; END IF;
  NEW."executionProfileSnapshot" := jsonb_build_object(
    'profileId', profile."id", 'profileName', profile."name", 'credentialLabel', credential."label", 'revision', profile."revision", 'spaceId', profile."spaceId", 'userId', profile."userId",
    'harness', profile."harness", 'provider', profile."provider", 'credentialId', profile."credentialId",
    'credentialSecretId', credential."secretId", 'protocol', profile."protocol", 'endpoint', profile."endpoint",
    'modelId', profile."modelId", 'runtimeVersion', profile."runtimeVersion", 'computerId', selected_computer
  );
  RETURN NEW;
END;
$$;
CREATE TRIGGER "runs_pin_execution_profile" BEFORE INSERT OR UPDATE OF "executionProfileSnapshot", "spaceId", "userId", "botId", "threadId" ON "runs"
FOR EACH ROW EXECUTE FUNCTION "pin_run_execution_profile"();
