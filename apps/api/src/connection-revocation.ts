import type { AdapterContext } from "@rakazo/adapter-kit";
import {
  acquireExclusiveConnectionAuthorizationLock,
  beginConnectionOperation,
  type ComposioProvider,
  CONNECTION_OPERATION_TRANSACTION_OPTIONS,
  connectionOperationSignal,
} from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";

export async function revokeConnection(
  deps: {
    prisma: Pick<PrismaClient, "$transaction">;
    composio?: Pick<ComposioProvider, "revoke">;
  },
  connectionId: string,
  context: AdapterContext,
): Promise<void> {
  await deps.prisma.$transaction(async (tx) => {
    const budget = await beginConnectionOperation(tx);
    const candidates = await tx.$queryRaw<Array<{ id: string; provider: string }>>`
        SELECT "id", "provider"
        FROM "connections"
        WHERE "id" = ${connectionId}
          AND "workspaceId" = ${context.workspaceId}
          AND "userId" = ${context.userId}
      `;
    const candidate = candidates[0];
    if (!candidate) return;

    await acquireExclusiveConnectionAuthorizationLock(tx, context.userId, candidate.provider);
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "connections"
        WHERE "userId" = ${context.userId}
          AND "provider" = ${candidate.provider}
        FOR UPDATE
      `;
    const row = rows.find((entry) => entry.id === candidate.id);
    if (!row) return;

    if (deps.composio) {
      await deps.composio.revoke(candidate.provider, {
        ...context,
        signal: connectionOperationSignal(budget, context.signal),
      });
    }

    await tx.connection.updateMany({
      where: {
        userId: context.userId,
        provider: candidate.provider,
      },
      data: { status: "revoked" },
    });
  }, CONNECTION_OPERATION_TRANSACTION_OPTIONS);
}
