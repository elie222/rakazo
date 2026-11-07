CREATE TABLE "work_activity_tokens" (
  "tokenDigest" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "ciphertext" TEXT NOT NULL,
  "lastState" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "work_activity_tokens_userId_idx" ON "work_activity_tokens"("userId");
ALTER TABLE "work_activity_tokens" ENABLE ROW LEVEL SECURITY;
CREATE POLICY work_activity_tokens_system ON "work_activity_tokens"
  USING ((SELECT app_rls_bypass()));
