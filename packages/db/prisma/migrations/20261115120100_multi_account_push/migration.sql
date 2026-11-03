-- Additive: keep push_tokens intact while the previous API release is running.
BEGIN;
LOCK TABLE "push_tokens" IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE "push_registrations" (
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "sessionId" TEXT NOT NULL,
  "ciphertext" TEXT NOT NULL,
  "tokenDigest" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  PRIMARY KEY ("userId", "sessionId")
);
CREATE INDEX "push_registrations_tokenDigest_idx" ON "push_registrations"("tokenDigest");
INSERT INTO "push_registrations" ("userId", "sessionId", "ciphertext", "tokenDigest", "updatedAt")
  SELECT "userId", "sessionId", "ciphertext", "tokenDigest", "updatedAt" FROM "push_tokens";
ALTER TABLE "push_registrations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY push_registrations_system ON "push_registrations"
  USING ((SELECT app_rls_bypass()));

-- Previous-release APIs still rotate or unregister through push_tokens.
CREATE FUNCTION sync_legacy_push_registration() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    UPDATE "push_registrations"
      SET "ciphertext" = NEW."ciphertext", "tokenDigest" = NEW."tokenDigest",
          "updatedAt" = NEW."updatedAt"
      WHERE "userId" = OLD."userId" AND "sessionId" = OLD."sessionId"
        AND "tokenDigest" = OLD."tokenDigest";
  ELSE
    -- Old registration transfers delete one owner before inserting the next.
    -- Check at commit so that transfer does not revoke another saved account.
    IF NOT EXISTS (SELECT 1 FROM "push_tokens" WHERE "tokenDigest" = OLD."tokenDigest") THEN
      DELETE FROM "push_registrations"
        WHERE "userId" = OLD."userId" AND "sessionId" = OLD."sessionId"
          AND "tokenDigest" = OLD."tokenDigest";
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER push_tokens_sync_rotation AFTER UPDATE ON "push_tokens"
  FOR EACH ROW WHEN (OLD."sessionId" = NEW."sessionId")
  EXECUTE FUNCTION sync_legacy_push_registration();
CREATE CONSTRAINT TRIGGER push_tokens_sync_unregister AFTER DELETE ON "push_tokens"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION sync_legacy_push_registration();
COMMIT;
