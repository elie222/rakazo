-- One row per device; push_tokens is dropped by the deferred migration that follows.
-- Hold the previous release's writes until the mirror trigger exists, so the backfill misses none.
LOCK TABLE "push_tokens" IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE "push_registrations" (
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "tokenDigest" TEXT NOT NULL UNIQUE,
  "sessionId" TEXT NOT NULL,
  "ciphertext" TEXT NOT NULL,
  "presentation" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  PRIMARY KEY ("userId", "tokenDigest")
);
CREATE INDEX "push_registrations_sessionId_idx" ON "push_registrations"("sessionId");
INSERT INTO "push_registrations" ("userId", "tokenDigest", "sessionId", "ciphertext", "presentation", "updatedAt")
  SELECT "userId", "tokenDigest", "sessionId", "ciphertext", "presentation", "updatedAt" FROM "push_tokens";
ALTER TABLE "push_registrations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY push_registrations_system ON "push_registrations"
  USING ((SELECT app_rls_bypass()));
-- The previous release keeps writing push_tokens during the deploy; mirror its writes until the drop.
CREATE FUNCTION push_tokens_mirror() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- An old-release delete ends that session's device, even if the new release rotated its token.
  IF TG_OP = 'DELETE' THEN
    DELETE FROM "push_registrations" WHERE "userId" = OLD."userId"
      AND ("tokenDigest" = OLD."tokenDigest" OR "sessionId" = OLD."sessionId");
    RETURN OLD;
  END IF;
  -- The same device kept its token: update only its own row, so a session retarget does not take
  -- back a token the new release has since handed to another account. A re-registration seals
  -- the token again, so a new ciphertext with no row left falls through and registers the device.
  IF TG_OP = 'UPDATE' AND OLD."tokenDigest" = NEW."tokenDigest" THEN
    UPDATE "push_registrations"
      SET "sessionId" = NEW."sessionId", "ciphertext" = NEW."ciphertext",
        "presentation" = NEW."presentation", "updatedAt" = NEW."updatedAt"
      WHERE "userId" = NEW."userId" AND "tokenDigest" = NEW."tokenDigest";
    IF FOUND OR NEW."ciphertext" = OLD."ciphertext" THEN
      RETURN NEW;
    END IF;
  END IF;
  -- An old-release update overwrites its one row per account; another device's row stays.
  DELETE FROM "push_registrations"
    WHERE "tokenDigest" = NEW."tokenDigest"
      OR ("userId" = NEW."userId" AND "sessionId" = NEW."sessionId");
  INSERT INTO "push_registrations" ("userId", "tokenDigest", "sessionId", "ciphertext", "presentation", "updatedAt")
    VALUES (NEW."userId", NEW."tokenDigest", NEW."sessionId", NEW."ciphertext", NEW."presentation", NEW."updatedAt");
  RETURN NEW;
END $$;
CREATE TRIGGER push_tokens_mirror AFTER INSERT OR UPDATE OR DELETE ON "push_tokens"
  FOR EACH ROW EXECUTE FUNCTION push_tokens_mirror();
