import type { AdapterContext } from "@rakazo/adapter-kit";
import type { ComposioProvider } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";

export async function revokeConnection(
  deps: {
    prisma: Pick<PrismaClient, "connection">;
    composio?: Pick<ComposioProvider, "revoke">;
  },
  connectionId: string,
  context: AdapterContext,
): Promise<void> {
  const row = await deps.prisma.connection.findFirst({
    where: {
      id: connectionId,
      workspaceId: context.workspaceId,
      userId: context.userId,
    },
  });
  if (!row) return;

  const revoked = await deps.prisma.connection.updateMany({
    where: {
      id: row.id,
      workspaceId: context.workspaceId,
      userId: context.userId,
    },
    data: { status: "revoked" },
  });
  if (revoked.count === 0 || !deps.composio) return;

  await deps.composio.revoke(row.provider, context);
}
