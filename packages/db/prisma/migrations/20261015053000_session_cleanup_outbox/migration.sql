ALTER TABLE "native_harness_sessions" ADD COLUMN "cleanupScope" JSONB;

-- Capture exact obsolete namespaces before history/bot cascades remove their metadata.
-- Legacy rows without a trusted scope are retained for computer/admin cleanup, never guessed.
CREATE FUNCTION "queue_obsolete_native_session"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."cleanupScope" IS NOT NULL AND (TG_OP = 'DELETE' OR OLD."epoch" IS DISTINCT FROM NEW."epoch") THEN
    INSERT INTO "native_state_cleanups" ("id", "spaceId", "userId", "computerId", "scope", "createdAt", "attempts")
    VALUES (gen_random_uuid()::text, OLD."spaceId", OLD."userId", OLD."cleanupScope"->>'computerId',
      OLD."cleanupScope" - 'computerId', CURRENT_TIMESTAMP, 0);
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "native_sessions_queue_cleanup" BEFORE DELETE OR UPDATE OF "epoch" ON "native_harness_sessions"
FOR EACH ROW EXECUTE FUNCTION "queue_obsolete_native_session"();

-- Retire transcripts immediately on account rotation/revocation, including OAuth paths.
-- The session deletion trigger above captures the exact old family before removal.
CREATE FUNCTION "retire_native_sessions_for_credential"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD."secretId" IS DISTINCT FROM NEW."secretId" THEN
    DELETE FROM "native_harness_sessions"
    WHERE "userId" = OLD."userId" AND "credentialSecretId" = OLD."secretId"
      AND "profileId" IN (
        SELECT "id" FROM "execution_profiles"
        WHERE "credentialId" = OLD."id" AND "userId" = OLD."userId"
      );
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "credential_retire_native_sessions" BEFORE DELETE OR UPDATE OF "secretId" ON "user_model_credentials"
FOR EACH ROW EXECUTE FUNCTION "retire_native_sessions_for_credential"();
