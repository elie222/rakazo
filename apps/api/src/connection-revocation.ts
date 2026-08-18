import type { AdapterContext } from "@rakazo/adapter-kit";
import type { ComposioProvider } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";

export async function revokeConnection(
  deps: {
    prisma: Pick<PrismaClient, "$transaction">;
    composio?: Pick<ComposioProvider, "revoke">;
  },
  connectionId: string,
  context: AdapterContext,
): Promise<void> {
  await deps.prisma.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; provider: string }>>`
        SELECT "id", "provider"
        FROM "connections"
        WHERE "id" = ${connectionId}
          AND "workspaceId" = ${context.workspaceId}
          AND "userId" = ${context.userId}
        FOR UPDATE
      `;
      const row = rows[0];
      if (!row) return;

      if (deps.composio) await deps.composio.revoke(row.provider, context);

      await tx.connection.updateMany({
        where: {
          id: row.id,
          workspaceId: context.workspaceId,
          userId: context.userId,
        },
        data: { status: "revoked" },
      });
    },
    { maxWait: 70_000, timeout: 70_000 },
  );
}
