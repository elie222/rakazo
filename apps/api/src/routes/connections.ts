import type { ConnectorCatalogItem } from "@rakazo/adapter-kit";
import {
  connectedContext,
  isLazyCatalogControlRoute,
  loadOrganizationReconnectCheck,
  planLiveConnectionSync,
  sanitizeIntegrationError,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { AppPermissionTool } from "@rakazo/core";
import {
  appToolApprovalKey,
  availableChatApps,
  deadlineSignal,
  isAvailableChatApp,
  withAbort,
} from "@rakazo/core";
import type { Prisma } from "@rakazo/db";
import {
  connectionIn,
  IsolationError,
  managedOrganizationId,
  recordSecurityEvent,
} from "@rakazo/db";
import { bestEffort, getLogger } from "@rakazo/logging";
import { connectionCreatedEvent } from "../auth/security-audit.js";
import {
  beginConnection,
  completeConnection,
  connectionContext,
  reconnectOrganizationConnection,
  revokeConnection,
} from "../integrations/connection-flows.js";
import {
  connectionDto,
  findManagedConnection,
  publishConnectionChange,
  requireConnectionOrganization,
  throwConnectionNameConflict,
} from "../integrations/connection-ownership.js";
import { recordToolConnected } from "../integrations/tool-connect-analytics.js";
import type { RouterDeps } from "../router.js";
import type { RouterContext } from "./context.js";

async function reconcileConnections(
  { prisma, analytics }: Pick<RouterDeps, "prisma" | "analytics">,
  owner: Pick<Actor, "spaceId" | "userId">,
  connectorId: string,
  connectedProviders: string[],
  reconnectRefs: string[],
  listConnectedRefs: () => Promise<string[] | undefined>,
): Promise<void> {
  const connectedProviderKeys = new Set(
    connectedProviders.map((provider) => provider.trim().toLowerCase()),
  );
  const rows = (
    await prisma.connection.findMany({
      where: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        connectorId,
        status: { in: ["pending", "connected"] },
      },
      select: {
        id: true,
        provider: true,
        displayName: true,
        status: true,
        updatedAt: true,
        createdAt: true,
        providerRef: true,
      },
      // Breaks a tie between attempts begun at the same moment in favour of the later row.
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    })
  ).filter((row: { provider: string }) =>
    connectedProviderKeys.has(row.provider.trim().toLowerCase()),
  );
  // Asked only when a sign-in is waiting to be matched to the account it created. When the
  // listing fails, the rows wait for the next pass instead of this one guessing.
  let sync: ReturnType<typeof planLiveConnectionSync> = { connectIds: [], revokeIds: [] };
  try {
    const liveRefs = rows.some((row) => row.status === "pending")
      ? await listConnectedRefs()
      : undefined;
    sync = planLiveConnectionSync(rows, connectedProviders, Date.now(), liveRefs);
  } catch (error) {
    getLogger().warn(`${connectorId} signed-in accounts could not be listed`, { error });
  }
  // One update per row so the credential event goes only to rows this call actually connected.
  const connectedIds: string[] = [];
  const updates = [
    ...sync.connectIds.map((id) => async (tx: Prisma.TransactionClient) => {
      const updated = await tx.connection.updateMany({
        where: { id, spaceId: owner.spaceId, userId: owner.userId, status: "pending" },
        data: { status: "connected" },
      });
      if (updated.count > 0) connectedIds.push(id);
    }),
    ...(sync.revokeIds.length > 0
      ? [
          (tx: Prisma.TransactionClient) =>
            tx.connection.updateMany({
              where: {
                id: { in: sync.revokeIds },
                spaceId: owner.spaceId,
                userId: owner.userId,
                status: "pending",
              },
              data: { status: "revoked" },
            }),
        ]
      : []),
    // The provider reports these accounts dead, so the app offers to connect them again.
    ...(reconnectRefs.length > 0
      ? [
          (tx: Prisma.TransactionClient) =>
            tx.connection.updateMany({
              where: {
                spaceId: owner.spaceId,
                userId: owner.userId,
                connectorId,
                status: "connected",
                providerRef: { in: reconnectRefs },
              },
              data: { status: "error" },
            }),
        ]
      : []),
  ];
  // Interactive rather than a batch: a batch cannot carry the request's database context.
  if (updates.length > 0)
    await prisma.$transaction(async (tx) => {
      for (const update of updates) await update(tx);
    });
  for (const id of connectedIds) {
    await recordSecurityEvent(connectionCreatedEvent("connections.catalog", id, owner));
    const row = rows.find((candidate) => candidate.id === id);
    if (row) recordToolConnected(analytics, owner.userId, row);
  }
}

/** Serialize begin/revoke for one user+provider so slug-wide remote deletes cannot race a new connect. */

export function connectionsRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  const healthChecks = new Map<
    string,
    {
      expiresAt: number;
      result: Promise<Awaited<ReturnType<typeof loadOrganizationReconnectCheck>> | undefined>;
    }
  >();

  function organizationHealth(
    actor: Actor,
    organizationId: string,
    connectorId: string,
    rows: { id: string; updatedAt: Date }[],
  ) {
    const provider = deps.connectors.managed(connectorId);
    if (!provider) return;
    // A saved connection change needs a fresh check, even when the provider kept its account ID.
    const key = JSON.stringify([
      organizationId,
      connectorId,
      rows.map(({ id, updatedAt }) => `${id}:${updatedAt.getTime()}`).sort(),
    ]);
    const now = Date.now();
    const existing = healthChecks.get(key);
    if (existing && existing.expiresAt > now) return existing.result;

    // Every client receiving the same change shares the same bounded provider request.
    const signal = deadlineSignal(4_000);
    const adapterContext = connectionContext(
      { ...actor, organizationId },
      "connections.list",
      signal,
    );
    const result = bestEffort(
      "check organization app sign-ins",
      withAbort(loadOrganizationReconnectCheck(provider, adapterContext), signal),
    );
    healthChecks.delete(key);
    healthChecks.set(key, { expiresAt: now + 30_000, result });
    if (healthChecks.size > 1_000) healthChecks.delete(healthChecks.keys().next().value!);
    return result;
  }

  return {
    connections: {
      catalog: authed.connections.catalog.handler(async ({ context, input }) => {
        const adapterContext = connectionContext(
          context.actor,
          "connections.catalog",
          context.signal,
        );
        const providers = input.connectorId
          ? [deps.connectors.managed(input.connectorId)].filter(
              (provider): provider is NonNullable<typeof provider> => Boolean(provider),
            )
          : deps.connectors.managedProviders();
        const catalogs = await Promise.all(
          providers.map(async (provider): Promise<ConnectorCatalogItem[]> => {
            try {
              const [items, reconnectRefs] = await Promise.all([
                provider.catalog(adapterContext, input.query),
                provider.listReconnectRefs?.(adapterContext).catch(() => []) ?? [],
              ]);
              const nowConnected = items.filter((item) => item.connected).map((item) => item.slug);
              if (nowConnected.length > 0 || reconnectRefs.length > 0) {
                await reconcileConnections(
                  deps,
                  context.actor,
                  provider.describe().id,
                  nowConnected,
                  reconnectRefs,
                  async () => provider.listConnectedRefs?.(adapterContext),
                ).catch((error) => {
                  getLogger().error(
                    `${provider.describe().id} connection reconciliation failed`,
                    error,
                  );
                });
              }
              return items;
            } catch (error) {
              getLogger().warn(`${provider.describe().id} catalog could not be loaded`, {
                error: sanitizeIntegrationError(error),
              });
              return [];
            }
          }),
        );
        const chatApps = deps.messaging?.enabled
          ? availableChatApps(deps.messaging.providers, Boolean(deps.messagingInstallations))
          : [];
        return catalogs
          .flat()
          .map((item) => (isAvailableChatApp(item, chatApps) ? { ...item, chatApp: true } : item));
      }),
      list: authed.connections.list.handler(async ({ context }) => {
        const rows = await deps.prisma.connection.findMany({
          where: connectionIn(context.actor),
        });
        const managed = rows.some((row) => row.organizationId)
          ? await managedOrganizationId(deps.prisma, context.actor)
          : null;
        const shared = rows.filter(
          (row) =>
            row.organizationId &&
            row.status === "connected" &&
            row.providerRef &&
            row.providerRef !== row.provider,
        );
        const reconnect = new Map<
          string,
          Awaited<ReturnType<typeof loadOrganizationReconnectCheck>>
        >();
        await Promise.all(
          [...new Set(shared.map((row) => row.connectorId))].map(async (connectorId) => {
            const owned = shared.filter((row) => row.connectorId === connectorId);
            const organizationId = owned[0]?.organizationId;
            if (!organizationId) return;
            const unhealthy = await organizationHealth(
              context.actor,
              organizationId,
              connectorId,
              owned,
            );
            if (unhealthy) reconnect.set(connectorId, unhealthy);
          }),
        );
        return rows.map((row) => {
          if (
            row.organizationId &&
            row.status === "connected" &&
            reconnect.get(row.connectorId)?.(row)
          )
            return connectionDto({ ...row, status: "error" }, managed);
          return connectionDto(row, managed);
        });
      }),
      begin: authed.connections.begin.handler(({ context, input }) =>
        beginConnection(deps, context, input),
      ),
      beginForOrganization: authed.connections.beginForOrganization.handler(
        async ({ context, input }) => {
          const organizationId = await requireConnectionOrganization(deps.prisma, context.actor);
          return beginConnection(deps, context, input, organizationId);
        },
      ),
      reconnectOrganization: authed.connections.reconnectOrganization.handler(
        ({ context, input }) => reconnectOrganizationConnection(deps, context, input.connectionId),
      ),
      complete: authed.connections.complete.handler(({ context, input }) =>
        completeConnection(deps, context, input),
      ),
      rename: authed.connections.rename.handler(async ({ context, input }) => {
        const { actor } = context;
        const row = await deps.prisma
          .$transaction(async (tx) => {
            const existing = await findManagedConnection(tx, actor, input.connectionId);
            if (!existing) throw new IsolationError();
            return tx.connection.update({
              where: { id: existing.id },
              data: { displayName: input.displayName },
            });
          })
          .catch(throwConnectionNameConflict);
        await publishConnectionChange(deps, actor, row.organizationId);
        return connectionDto(row, row.organizationId);
      }),
      revoke: authed.connections.revoke.handler(({ context, input }) =>
        revokeConnection(deps, context, input),
      ),
      tools: authed.connections.tools.handler(async ({ context, input }) => {
        const connector = deps.connectors.managed(input.connectorId);
        if (!connector) return [];
        const rows = await deps.prisma.connection.findMany({
          where: {
            ...connectionIn(context.actor),
            connectorId: input.connectorId,
            provider: { equals: input.provider, mode: "insensitive" },
            status: "connected",
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        });
        if (rows.length === 0) return [];
        try {
          const adapterContext = {
            ...connectionContext(context.actor, "connections.tools", context.signal),
            ...connectedContext(rows),
            connectedProviders: [input.provider],
          };
          adapterContext.signal.throwIfAborted();
          const tools = connector.listAppTools
            ? await connector.listAppTools(adapterContext, input.provider)
            : await connector.discoverTools(adapterContext);
          adapterContext.signal.throwIfAborted();
          const appTools = new Map<string, AppPermissionTool>();
          for (const tool of tools) {
            if (tool.batch || isLazyCatalogControlRoute(tool.route)) continue;
            const approvalKey = appToolApprovalKey(tool.route) ?? tool.name;
            const key = approvalKey.toLowerCase();
            const existing = appTools.get(key);
            if (existing) {
              if (tool.readOnly === false) existing.readOnly = false;
              continue;
            }
            appTools.set(key, {
              name: tool.route?.connectionId ? tool.route.toolName : tool.name,
              description: tool.description,
              readOnly: tool.readOnly,
              approvalKey,
            });
          }
          return [...appTools.values()];
        } catch (error) {
          if (!context.signal?.aborted) throw error;
          getLogger().warn("connections.tools cancelled", {
            connectorId: input.connectorId,
            provider: input.provider,
            error: error instanceof Error ? error.message : String(error),
          });
          return [];
        }
      }),
    },
  };
}
