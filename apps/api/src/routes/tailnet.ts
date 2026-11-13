import { ORPCError } from "@orpc/server";
import { PrivateNetworkError } from "@rakazo/adapter-kit";
import type { TailnetCommandAccess, TailnetService } from "@rakazo/adapters";
import {
  getTailnetConnection,
  removeTailnetConnection,
  saveTailnetConnection,
  setTailnetBotAccess,
  TailnetBotNotFoundError,
} from "@rakazo/adapters";
import type { Actor, TailnetStatus } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import type { RouterContext } from "./context.js";

/** Tailnet access as the router needs it; absent turns the procedures into a refusal. */
export type TailnetRouteDeps = {
  service: Pick<TailnetService, "available" | "verify" | "disconnect">;
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
        try {
          await saveTailnetConnection({
            prisma: deps.prisma,
            secretStore: deps.secrets,
            scope: scope(context.actor),
            config: input,
            verify: (config) =>
              tailnet.service.verify(config, signal ?? AbortSignal.timeout(30_000)),
          });
        } catch (error) {
          if (error instanceof PrivateNetworkError) {
            throw new ORPCError("BAD_REQUEST", { message: error.message });
          }
          throw error;
        }
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
        let updated: Awaited<ReturnType<typeof setTailnetBotAccess>>;
        try {
          updated = await setTailnetBotAccess({
            prisma: deps.prisma,
            scope: scope(context.actor),
            botId: input.botId,
            enabled: input.enabled,
          });
        } catch (error) {
          if (error instanceof TailnetBotNotFoundError) {
            throw new ORPCError("NOT_FOUND", { message: error.message });
          }
          throw error;
        }
        if (!updated) throw new ORPCError("BAD_REQUEST", { message: "Connect Tailscale first." });
        if (!input.enabled) await tailnet?.service.disconnect(scope(context.actor), input.botId);
        return status(context.actor);
      }),
    },
  };
}

async function unavailable(
  tailnet: TailnetRouteDeps | undefined,
): Promise<TailnetStatus["unavailable"]> {
  if (!tailnet?.service.available) return "no_tailscale";
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
