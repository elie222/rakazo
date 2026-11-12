import { ORPCError } from "@orpc/server";
import {
  buildMcpCredentialBlob,
  deploymentApps,
  holdSecretNotifications,
  persistPreparedSecret,
} from "@rakazo/adapters";
import type { Actor, ConnectionCatalogItem } from "@rakazo/contracts";
import { availableInSpace, runAsSystemInTransaction } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
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
  let catalog: ReturnType<typeof apps>;
  try {
    catalog = apps(ctx);
  } catch {
    getLogger().warn("Bundled app configuration is invalid");
    return [];
  }
  const rows = await ctx.deps.prisma.mcpServer.findMany({
    where: {
      ...availableInSpace(actor),
      deploymentAppId: { not: null },
    },
  });
  return Promise.all(
    catalog.map(async (app) => {
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
export async function connectDeploymentApp(
  ctx: RouterContext,
  actor: Actor,
  appId: string,
  botId?: string,
) {
  let app: ReturnType<typeof apps>[number] | undefined;
  try {
    app = apps(ctx).find((app) => app.id === appId);
  } catch {
    throw new ORPCError("PRECONDITION_FAILED", { message: "This app needs server setup." });
  }
  if (!app) throw new ORPCError("NOT_FOUND");
  if (!app.config)
    throw new ORPCError("PRECONDITION_FAILED", { message: "This app needs server setup." });
  const input = app.config;
  // These are bundled, trusted configurations. Never accept a client-supplied command or secret.
  const payload = buildMcpCredentialBlob(input);
  if (!payload) throw new Error("Deployment app has no OAuth configuration");
  let written: { id: string; ciphertext: string } | undefined;
  try {
    const row = await holdSecretNotifications(() =>
      ctx.deps.prisma.$transaction(async (tx) => {
        await lockOwner(tx, actor.userId, "deployment-apps");
        const bot = botId
          ? await tx.bot.findFirst({
              where: { id: botId, spaceId: actor.spaceId },
              select: { id: true },
            })
          : null;
        if (botId && !bot) throw new ORPCError("NOT_FOUND");
        const existing = await runAsSystemInTransaction(
          tx,
          "Find owner's bundled app connection",
          () =>
            tx.mcpServer.findFirst({
              where: { userId: actor.userId, deploymentAppId: appId },
              include: { availableIn: { select: { spaceId: true } } },
            }),
        );
        if (
          existing &&
          (!existing.enabled ||
            !(
              existing.spaceId === actor.spaceId ||
              existing.allSpaces ||
              existing.availableIn.some((space) => space.spaceId === actor.spaceId)
            ))
        ) {
          throw new ORPCError("PRECONDITION_FAILED", {
            message: "Enable this connection in this space before reconnecting.",
          });
        }
        let server = existing;
        if (!server) {
          const stored = await ctx.deps.secrets.put(
            payload,
            computerContext(actor, "mcp", "mcp.app"),
          );
          written = stored;
          const created = await ctx.insertMcpServer(tx, actor, input, stored, {
            everywhere: true,
          });
          server = await tx.mcpServer.update({
            where: { id: created.id },
            data: { deploymentAppId: appId, allBots: false },
            include: { availableIn: { select: { spaceId: true } } },
          });
        }
        if (bot)
          await tx.botMcpServer.upsert({
            where: { botId_serverId: { botId: bot.id, serverId: server.id } },
            create: {
              spaceId: actor.spaceId,
              userId: actor.userId,
              botId: bot.id,
              serverId: server.id,
              allowAllTools: true,
              allowedTools: [],
            },
            update: {},
          });
        return server;
      }),
    );
    return { serverId: row.id };
  } catch (error) {
    // A failure before inserting the secret row is invisible to transaction tracking.
    if (written)
      await persistPreparedSecret(
        ctx.deps.prisma,
        ctx.deps.secrets,
        written,
        async () => undefined,
      );
    throw error;
  }
}
