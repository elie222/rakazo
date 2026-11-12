import { ORPCError } from "@orpc/server";
import { buildMcpCredentialBlob, deploymentApps, holdSecretNotifications } from "@rakazo/adapters";
import type { Actor, ConnectionCatalogItem } from "@rakazo/contracts";
import { availableInSpace } from "@rakazo/db";
import { lockOwner } from "./availability.js";
import type { RouterContext } from "./routes/context.js";
import { computerContext } from "./routes/shared.js";

function apps(ctx: RouterContext) {
  return deploymentApps(ctx.deps.env.deploymentApps).map((app) => ({
    ...app,
    config:
      app.config?.transport === "stdio" &&
      ctx.deps.env.mcpStdioEnabled &&
      (ctx.deps.env.mcpStdioAllowedCommands ?? []).includes(app.config.command)
        ? app.config
        : null,
  }));
}

export async function deploymentAppCatalog(
  ctx: RouterContext,
  actor: Actor,
): Promise<ConnectionCatalogItem[]> {
  const rows = await ctx.deps.prisma.mcpServer.findMany({
    where: {
      ...availableInSpace(actor),
      deploymentAppId: { not: null },
    },
  });
  return Promise.all(
    apps(ctx).map(async (app) => {
      const row = rows.find((row) => row.deploymentAppId === app.id);
      const summary = row ? await ctx.mcpOAuth.summaryFor(row, actor) : null;
      return {
        connectorId: "deployment",
        slug: app.id,
        name: app.name,
        logo: null,
        connected: !!row?.enabled && summary?.status === "connected",
        noAuth: false,
        mcpAppId: app.id,
        ...(row ? { mcpServerId: row.id } : {}),
        needsSetup: !app.config,
      };
    }),
  );
}

/** A user selects only an app id. Commands and OAuth clients are operator-owned. */
export async function connectDeploymentApp(ctx: RouterContext, actor: Actor, appId: string) {
  const app = apps(ctx).find((app) => app.id === appId);
  if (!app) throw new ORPCError("NOT_FOUND");
  if (!app.config)
    throw new ORPCError("PRECONDITION_FAILED", { message: "This app needs server setup." });
  const input = app.config;
  // These are bundled, trusted configurations. Never accept a client-supplied command or secret.
  const payload = buildMcpCredentialBlob(input);
  if (!payload) throw new Error("Deployment app has no OAuth configuration");
  const row = await holdSecretNotifications(() =>
    ctx.deps.prisma.$transaction(async (tx) => {
      await lockOwner(tx, actor.userId, "deployment-apps");
      const existing = await tx.mcpServer.findFirst({
        where: { userId: actor.userId, deploymentAppId: appId },
      });
      if (existing) return existing;
      const stored = await ctx.deps.secrets.put(payload, computerContext(actor, "mcp", "mcp.app"));
      const created = await ctx.insertMcpServer(tx, actor, input, stored, { everywhere: true });
      return tx.mcpServer.update({
        where: { id: created.id },
        data: { deploymentAppId: appId, allBots: false },
      });
    }),
  );
  return { serverId: row.id };
}
