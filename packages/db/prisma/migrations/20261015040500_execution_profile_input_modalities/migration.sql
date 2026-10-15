-- Existing immutable revisions and already pinned runs remain conservatively text-only.
ALTER TABLE "execution_profiles" ADD COLUMN "inputModalities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "execution_profiles" ADD CONSTRAINT "execution_profiles_inputModalities_check"
  CHECK ("inputModalities" <@ ARRAY['image', 'audio']::TEXT[] AND cardinality("inputModalities") <= 2
    AND cardinality(array_positions("inputModalities", 'image')) <= 1
    AND cardinality(array_positions("inputModalities", 'audio')) <= 1);

CREATE OR REPLACE FUNCTION "pin_run_execution_profile"() RETURNS trigger LANGUAGE plpgsql AS $$
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
    'modelId', profile."modelId", 'inputModalities', to_jsonb(profile."inputModalities"), 'runtimeVersion', profile."runtimeVersion", 'computerId', selected_computer
  );
  RETURN NEW;
END;
$$;
