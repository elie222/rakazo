import type { AdapterContext } from "@rakazo/adapter-kit";
import {
  acquireExclusiveConnectionAuthorizationLock,
  beginConnectionOperation,
  CONNECTION_OPERATION_TRANSACTION_OPTIONS,
  type ConnectorRegistry,
  connectionOperationSignal,
} from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";

export async function revokeConnection(
  deps: {
    prisma: Pick<PrismaClient, "$transaction">;
    connectors: Pick<ConnectorRegistry, "managed">;
  },
  connectionId: string,
  context: AdapterContext,
): Promise<void> {
  await deps.prisma.$transaction(async (tx) => {
    const budget = await beginConnectionOperation(tx);
    const candidates = await tx.$queryRaw<
      Array<{ id: string; connectorId: string; provider: string }>
    >`
        SELECT "id", "connectorId", "provider"
        FROM "connections"
        WHERE "id" = ${connectionId}
          AND "workspaceId" = ${context.workspaceId}
          AND "userId" = ${context.userId}
      `;
    const candidate = candidates[0];
    if (!candidate) return;

    await acquireExclusiveConnectionAuthorizationLock(
      tx,
      context.userId,
      candidate.connectorId,
      candidate.provider,
    );
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "connections"
        WHERE "userId" = ${context.userId}
          AND "connectorId" = ${candidate.connectorId}
          AND "provider" = ${candidate.provider}
        FOR UPDATE
      `;
    const row = rows.find((entry) => entry.id === candidate.id);
    if (!row) return;

    const connector = deps.connectors.managed(candidate.connectorId);
    if (!connector) throw new Error(`Connector ${candidate.connectorId} is not configured`);
    await connector.revoke(candidate.provider, {
      ...context,
      signal: connectionOperationSignal(budget, context.signal),
    });

    await tx.connection.updateMany({
      where: {
        userId: context.userId,
        connectorId: candidate.connectorId,
        provider: candidate.provider,
      },
      data: { status: "revoked" },
    });
  }, CONNECTION_OPERATION_TRANSACTION_OPTIONS);
}
