-- One row per device; push_tokens is dropped by the deferred migration that follows.
CREATE TABLE "push_registrations" (
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "tokenDigest" TEXT NOT NULL UNIQUE,
  "sessionId" TEXT NOT NULL,
  "ciphertext" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  PRIMARY KEY ("userId", "tokenDigest")
);
CREATE INDEX "push_registrations_sessionId_idx" ON "push_registrations"("sessionId");
INSERT INTO "push_registrations" ("userId", "tokenDigest", "sessionId", "ciphertext", "updatedAt")
  SELECT "userId", "tokenDigest", "sessionId", "ciphertext", "updatedAt" FROM "push_tokens";
ALTER TABLE "push_registrations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY push_registrations_system ON "push_registrations"
  USING ((SELECT app_rls_bypass()));
-- The previous release keeps writing push_tokens during the deploy; mirror its writes until the drop.
CREATE FUNCTION push_tokens_mirror() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    DELETE FROM "push_registrations" WHERE "userId" = OLD."userId" AND "tokenDigest" = OLD."tokenDigest";
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  DELETE FROM "push_registrations"
    WHERE "tokenDigest" = NEW."tokenDigest"
      OR ("userId" = NEW."userId" AND "sessionId" = NEW."sessionId");
  INSERT INTO "push_registrations" ("userId", "tokenDigest", "sessionId", "ciphertext", "updatedAt")
    VALUES (NEW."userId", NEW."tokenDigest", NEW."sessionId", NEW."ciphertext", NEW."updatedAt");
  RETURN NEW;
END $$;
CREATE TRIGGER push_tokens_mirror AFTER INSERT OR UPDATE OR DELETE ON "push_tokens"
  FOR EACH ROW EXECUTE FUNCTION push_tokens_mirror();
