DELETE FROM "connections" AS older
USING "connections" AS newer
WHERE older.status = 'pending'
  AND newer.status = 'pending'
  AND older."workspaceId" = newer."workspaceId"
  AND older."userId" = newer."userId"
  AND older."connectorId" = newer."connectorId"
  AND older.provider = newer.provider
  AND (
    older."createdAt" < newer."createdAt"
    OR (older."createdAt" = newer."createdAt" AND older.id < newer.id)
  );

CREATE UNIQUE INDEX "connections_workspaceId_userId_connectorId_provider_pending_key"
ON "connections"("workspaceId", "userId", "connectorId", "provider")
WHERE status = 'pending';
