-- If a build fails, inspect the index and the migration error first, then use
-- prisma migrate resolve --rolled-back 20261015010000_ringing_call_recovery
-- before deploying again. The following guard requires online repair of invalid leftovers.
-- Match the reconciler's JSON path filter and scan only call requests.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "messages_call_recovery_idx" ON "messages"
((blocks #> ARRAY['0', 'status']), "createdAt")
WHERE role = 'bot' AND "clientNonce" LIKE 'call:%' AND "clientNonce" LIKE '%:request';
