import { ORPCError } from "@orpc/server";
import type { TailnetCommandAccess, TailnetRoute, TailnetService } from "@rakazo/adapters";
import {
  botTailnetRoute,
  getTailnetConnection,
  removeTailnetConnection,
  saveTailnetConnection,
  setTailnetBotAccess,
  toComputerRef,
} from "@rakazo/adapters";
import type { Actor, TailnetStatus } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { RouterContext } from "./context.js";
import { computerContext } from "./shared.js";

/** Tailnet access as the router needs it; absent turns the procedures into a refusal. */
export type TailnetRouteDeps = {
  service: Pick<TailnetService, "available" | "verify" | "disconnect" | "dial">;
  /** This server's origin as bots' computers reach it; absent when they can't. */
  serverOrigin: string | undefined;
  /** Gives a computer's browsers their tailnet proxy when a member takes control of a screen. */
  computers?: Pick<TailnetCommandAccess, "prepareComputer">;
};

/**
 * The signed-in member's own tailnet connection in the current Space. Every procedure reads and
 * writes only the actor's row; changing it takes the affected bot nodes off the tailnet now.
 */
export function tailnetRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  const tailnet = deps.tailnet;
  const scope = (actor: Actor) => ({ userId: actor.userId, spaceId: actor.spaceId });
  const status = (actor: Actor) => tailnetStatus(deps.prisma, tailnet, scope(actor));
  return {
    tailnet: {
      status: authed.tailnet.status.handler(({ context }) => status(context.actor)),
      connect: authed.tailnet.connect.handler(async ({ context, input, signal }) => {
        if (!tailnet || (await unavailable(tailnet))) {
          throw new ORPCError("BAD_REQUEST", {
            message: "This server can't put bots on a tailnet.",
          });
        }
        await saveTailnetConnection({
          prisma: deps.prisma,
          secretStore: deps.secrets,
          scope: scope(context.actor),
          config: input,
          verify: (config) => tailnet.service.verify(config, signal ?? AbortSignal.timeout(30_000)),
        });
        // Nodes joined with the old client keep its tag until they leave.
        await tailnet.service.disconnect(scope(context.actor));
        return status(context.actor);
      }),
      disconnect: authed.tailnet.disconnect.handler(async ({ context }) => {
        await removeTailnetConnection({ prisma: deps.prisma, scope: scope(context.actor) });
        await tailnet?.service.disconnect(scope(context.actor));
        return status(context.actor);
      }),
      setBotAccess: authed.tailnet.setBotAccess.handler(async ({ context, input }) => {
        const updated = await setTailnetBotAccess({
          prisma: deps.prisma,
          scope: scope(context.actor),
          botId: input.botId,
          enabled: input.enabled,
        });
        if (!updated)
          throw new ORPCError("BAD_REQUEST", { message: "Connect your tailnet first." });
        if (!input.enabled) await tailnet?.service.disconnect(scope(context.actor), input.botId);
        // A screen the member already controls can browse the tailnet from now on.
        else prepareTailnetBrowser(ctx, context.actor, input.botId);
        return status(context.actor);
      }),
    },
  };
}

/**
 * Starts the browsers' tailnet proxy on a bot's running computer, in the background: neither
 * taking control nor turning access on waits for it.
 */
export function prepareTailnetBrowser(
  ctx: Pick<RouterContext, "deps" | "repos">,
  actor: Actor,
  botId: string,
): void {
  const { deps, repos } = ctx;
  const computers = deps.tailnet?.computers;
  if (!computers) return;
  void (async () => {
    const bot = await repos.getBot(actor, botId);
    const computer = bot.computer;
    if (!computer?.providerRef || computer.state !== "running") return;
    await computers.prepareComputer({
      sandbox: deps.sandbox,
      computerId: computer.id,
      computer: toComputerRef(computer),
      member: { userId: actor.userId, spaceId: actor.spaceId, botId: bot.id },
      context: computerContext(actor, bot.id, "takeover"),
    });
  })().catch((error: unknown) =>
    getLogger().warn("tailnet browser proxy not prepared", {
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}

async function unavailable(
  tailnet: TailnetRouteDeps | undefined,
): Promise<TailnetStatus["unavailable"]> {
  if (!tailnet?.service.available) return "unsupported";
  if (!tailnet.serverOrigin) return "no_server_address";
  return null;
}

export async function tailnetStatus(
  prisma: Pick<PrismaClient, "tailnetConnection">,
  tailnet: TailnetRouteDeps | undefined,
  scope: { userId: string; spaceId: string },
): Promise<TailnetStatus> {
  return {
    unavailable: await unavailable(tailnet),
    connection: await getTailnetConnection(prisma, scope),
  };
}

/** Why a server on a tailnet can't be checked when adding it. */
export const TAILNET_CHECK_NEEDS_BOT =
  "Turn on tailnet access for a bot to add a server on your tailnet.";

/**
 * How to reach a tailnet MCP server while adding it: from one of the member's bots allowed on
 * their tailnet in this Space, as runs will. Undefined for any other address or server.
 */
export async function tailnetCheckRoute(
  deps: { prisma: Pick<PrismaClient, "tailnetConnection" | "bot">; tailnet?: TailnetRouteDeps },
  actor: Actor,
  isTailnetSource: boolean,
): Promise<TailnetRoute | undefined> {
  if (!isTailnetSource || !deps.tailnet?.service.available) return undefined;
  const connection = await getTailnetConnection(deps.prisma, actor);
  const bot = connection?.botIds.length
    ? await deps.prisma.bot.findFirst({
        where: { id: { in: connection.botIds }, spaceId: actor.spaceId },
        select: { id: true },
      })
    : null;
  if (!bot) throw new ClientError("BAD_REQUEST", TAILNET_CHECK_NEEDS_BOT);
  return botTailnetRoute(
    deps.tailnet.service,
    deps.prisma,
    { userId: actor.userId, spaceId: actor.spaceId, botId: bot.id },
    "capabilities.install",
  );
}
