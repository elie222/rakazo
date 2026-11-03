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
