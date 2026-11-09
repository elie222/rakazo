-- Additive: which of a member's connections runs a bot's model for that member.
CREATE TABLE "user_bot_model_connections" (
  "userId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "modelId" TEXT NOT NULL,
  "credentialId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "user_bot_model_connections_pkey" PRIMARY KEY ("userId", "botId"),
  CONSTRAINT "user_bot_model_connections_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "user_bot_model_connections_botId_fkey" FOREIGN KEY ("botId")
    REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "user_bot_model_connections_credentialId_userId_fkey" FOREIGN KEY ("credentialId", "userId")
    REFERENCES "user_model_credentials"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "user_bot_model_connections_botId_idx" ON "user_bot_model_connections"("botId");
CREATE INDEX "user_bot_model_connections_credentialId_userId_idx"
  ON "user_bot_model_connections"("credentialId", "userId");

ALTER TABLE "user_bot_model_connections" ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_bot_model_connections_tenant ON "user_bot_model_connections"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY user_bot_model_connections_system ON "user_bot_model_connections"
  USING ((SELECT app_rls_bypass()));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "user_bot_model_connections" TO rakazo_app;
  END IF;
END
$$;
