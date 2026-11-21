CREATE TABLE "pruned_message_nonces" (
  "threadId" TEXT NOT NULL REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "clientNonce" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "seq" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("threadId", "clientNonce")
);

ALTER TABLE "pruned_message_nonces" ENABLE ROW LEVEL SECURITY;
CREATE POLICY pruned_message_nonces_tenant ON "pruned_message_nonces"
  USING (EXISTS (
    SELECT 1 FROM "threads" t
    WHERE t."id" = "pruned_message_nonces"."threadId"
      AND t."spaceId" = NULLIF(current_setting('app.space_id', true), '')
  ));
CREATE POLICY pruned_message_nonces_system ON "pruned_message_nonces"
  USING ((SELECT app_rls_bypass()));
