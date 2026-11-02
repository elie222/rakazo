-- Additive: keep push_tokens intact while the previous API release is running.
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
