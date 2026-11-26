import type { AdapterContext, ManagedConnectorProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import type { PluginConnectionRow } from "../providers/integration/composio/composio-connector.js";
import { planLiveConnectionSync } from "../providers/integration/composio/composio-connector.js";
import type { ExecutorDeps } from "../runs/executor/executor-deps.js";

export function selectRunConnections<
  T extends {
    connectorId: string;
    provider: string;
    status: string;
    organizationId?: string | null;
  },
>(rows: T[], connectedComposioProviders: string[]): T[] {
  const liveProviders = new Set(
    connectedComposioProviders.map((provider) => provider.trim().toLowerCase()).filter(Boolean),
  );
  const connectedKeys = new Set(
    rows
      .filter((row) => row.status === "connected")
      .map((row) => `${row.connectorId}:${row.provider.trim().toLowerCase()}`),
  );
  return rows.filter((row) => {
    if (row.status === "connected") return true;
    if (row.status === "revoked" || row.organizationId) return false;
    // Recover a pending/error Composio row only when this provider has no
    // connected row of its own. A sibling that shares the slug must not
    // pull a non-live row — and its dead providerRef — into the run.
    if (row.connectorId !== "composio") return false;
    if (row.status !== "pending" && row.status !== "error") return false;
    const providerKey = row.provider.trim().toLowerCase();
    if (!liveProviders.has(providerKey)) return false;
    return !connectedKeys.has(`composio:${providerKey}`);
  });
}

/** Authorized connection metadata shared by model runs and unattended checks. */
export function connectedContext(
  rows: Array<{
    id: string;
    connectorId: string;
    provider: string;
    displayName: string;
    providerRef: string | null;
    organizationId?: string | null;
  }>,
): Pick<AdapterContext, "connectedConnections" | "connectedProviders"> {
  return {
    connectedConnections: [...rows]
      .sort((a, b) => Number(Boolean(a.organizationId)) - Number(Boolean(b.organizationId)))
      .map((row) => ({
        id: row.id,
        connectorId: row.connectorId,
        externalId: row.provider,
        displayName: row.displayName,
        providerRef: row.providerRef ?? undefined,
        ...(row.organizationId ? { organizationId: row.organizationId } : {}),
      })),
    connectedProviders: rows
      .filter((row) => row.connectorId === "composio")
      .map((row) => row.provider),
  };
}

/** A concrete saved account must still be active. A slug ref can be a no-auth app. */
export async function loadOrganizationReconnectCheck(
  provider: ManagedConnectorProvider,
  context: AdapterContext,
): Promise<(connection: { provider: string; providerRef: string | null }) => boolean> {
  const active = await provider.listConnectedRefs?.(context);
  const refs = new Set(active ?? (await provider.listReconnectRefs?.(context)));
  return ({ provider: app, providerRef }) =>
    Boolean(
      providerRef &&
        providerRef !== app &&
        (active ? !refs.has(providerRef) : refs.has(providerRef)),
    );
}

export async function loadLivePlugins(
  listConnectedPlugins: ExecutorDeps["listConnectedPlugins"],
  userId: string,
): Promise<{ ok: true; slugs: string[]; refs?: string[]; refsFailed?: boolean } | { ok: false }> {
  if (!listConnectedPlugins) return { ok: false };
  try {
    return { ok: true, ...(await listConnectedPlugins(userId)) };
  } catch {
    return { ok: false };
  }
}

export async function persistLivePluginConnections(
  prisma: PrismaClient,
  owner: { userId: string; spaceId: string },
  rows: PluginConnectionRow[],
  live: { slugs: string[]; refs?: string[]; refsFailed?: boolean },
): Promise<void> {
  // The rows wait for a pass that can tell whose account is signed in.
  if (live.refsFailed) return;
  const sync = planLiveConnectionSync(rows, live.slugs, Date.now(), live.refs);
  if (sync.connectIds.length > 0) {
    await prisma.connection.updateMany({
      where: {
        id: { in: sync.connectIds },
        userId: owner.userId,
        spaceId: owner.spaceId,
        // A row revoked since the run read it stays revoked.
        status: { in: ["pending", "error"] },
      },
      data: { status: "connected" },
    });
    for (const row of rows) {
      if (sync.connectIds.includes(row.id)) row.status = "connected";
    }
  }
  if (sync.revokeIds.length > 0) {
    await prisma.connection.updateMany({
      where: {
        id: { in: sync.revokeIds },
        userId: owner.userId,
        spaceId: owner.spaceId,
        status: { in: ["pending", "error"] },
      },
      data: { status: "revoked" },
    });
    for (const row of rows) {
      if (sync.revokeIds.includes(row.id)) row.status = "revoked";
    }
  }
}
