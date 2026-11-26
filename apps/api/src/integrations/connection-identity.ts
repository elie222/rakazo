import type { AdapterContext, ManagedConnectorProvider } from "@rakazo/adapter-kit";
import { connectionOwnerWhere } from "@rakazo/adapters";
import { mapConcurrent } from "@rakazo/core";
import type { Prisma } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

export async function findDuplicateAccount(
  tx: Pick<Prisma.TransactionClient, "connection">,
  connector: ManagedConnectorProvider,
  current: { id: string; connectorId: string; provider: string },
  accountId: string,
  context: AdapterContext,
) {
  if (!connector.prepareAccountIdentityLookup && !connector.connectedAccountIdentity) return;
  try {
    const identify = connector.prepareAccountIdentityLookup
      ? await connector.prepareAccountIdentityLookup(current.provider, context)
      : (ref: string) => connector.connectedAccountIdentity?.(current.provider, ref, context);
    const identity = await identify(accountId);
    if (!identity) return;
    const siblings = await tx.connection.findMany({
      where: {
        ...connectionOwnerWhere(context),
        connectorId: current.connectorId,
        provider: { equals: current.provider, mode: "insensitive" },
        status: "connected",
        id: { not: current.id },
      },
    });
    const candidates = siblings.flatMap((sibling) => {
      const ref = sibling.providerRef;
      return ref && ref !== sibling.provider && ref !== accountId ? [{ sibling, ref }] : [];
    });
    const identities = await mapConcurrent(candidates, 4, async ({ ref }) => identify(ref));
    return candidates.find((_, index) => identities[index] === identity)?.sibling;
  } catch (error) {
    context.signal.throwIfAborted();
    getLogger().warn("connections.complete could not verify account identity", {
      error,
      connectionId: current.id,
    });
    return "retry" as const;
  }
}
