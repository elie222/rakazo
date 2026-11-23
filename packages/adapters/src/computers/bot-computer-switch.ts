import type { AgentHomeStore, SandboxProvider } from "@rakazo/adapter-kit";
import { createAdapterContext } from "@rakazo/adapter-kit";
import type { Actor, Bot, ComputerMode } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES, ClientError, computerUsingRuns } from "@rakazo/core";
import type { createRepos, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  expireComputerExecutionLeases,
  hasActiveComputerControl,
  IsolationError,
  isRecordNotFound,
  recordComputerRunEnd,
} from "@rakazo/db";
import { toComputerRef } from "./computer-lifecycle.js";
import { checkpointAndStopComputer } from "./computer-workspace.js";
import { endTeachingWithLease } from "./screens/computer-control.js";

export type BotComputerSwitchDeps = {
  prisma: PrismaClient;
  home: AgentHomeStore;
  sandbox: SandboxProvider;
  events: Pick<ThreadEvents, "draftRecordingsOfLease">;
  repos: Pick<ReturnType<typeof createRepos>, "getBot" | "setBotComputer">;
};

/**
 * Moves a bot between the Space's team computer and its own. Leaving its own computer saves and
 * stops it first, so nothing it was doing is lost; a bot that is working or being driven by a
 * person is refused instead.
 */
export async function switchBotComputer(
  deps: BotComputerSwitchDeps,
  actor: Actor,
  botId: string,
  mode: ComputerMode,
): Promise<{ bot: Bot; switched: boolean }> {
  const bot = await deps.repos.getBot(actor, botId);
  if (!bot.computer) throw new IsolationError();
  const currentMode = bot.computer.scope === "dedicated" ? "dedicated" : "team";
  if (currentMode === mode) {
    return { bot: await deps.repos.setBotComputer(actor, bot.id, mode), switched: false };
  }
  const claimed = await deps.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM computers WHERE id = ${bot.computerId} FOR UPDATE`;
    return tx.bot.updateMany({
      where: { id: bot.id, computerSwitching: false, computer: { maintenanceId: null } },
      data: { computerSwitching: true },
    });
  });
  if (claimed.count !== 1)
    throw new ClientError("CONFLICT", "The computer is busy; try again in a moment.");
  try {
    const active = await deps.prisma.run.findFirst({
      where: { botId: bot.id, status: { in: [...ACTIVE_RUN_STATUSES] }, ...computerUsingRuns() },
      select: { id: true },
    });
    if (active) throw new ClientError("BAD_REQUEST", "Stop the bot first");
    if (bot.computer.controlBotId === bot.id && hasActiveComputerControl(bot.computer)) {
      throw new ClientError("BAD_REQUEST", "Release the computer first");
    }
    if (bot.computer.scope === "dedicated" && bot.computer.providerRef) {
      const context = createAdapterContext(actor, bot.id, "computer.switch");
      const ref = toComputerRef(bot.computer);
      if (bot.computer.state === "running") {
        await checkpointAndStopComputer(deps, bot.computer, ref, context);
      }
      await expireComputerExecutionLeases(deps.prisma, {
        computerId: bot.computer.id,
        botId: bot.id,
      });
      await deps.prisma.computer.update({
        where: { id: bot.computer.id },
        data: {
          state: "stopped",
          controlHolder: "none",
          controlLeaseId: null,
          controlUserId: null,
          controlLeaseExpiresAt: null,
          controlBotId: null,
        },
      });
      await recordComputerRunEnd(deps.prisma, bot.computer, "stopped");
      await endTeachingWithLease(deps, actor.spaceId, bot.computer.controlLeaseId);
    }
    return { bot: await deps.repos.setBotComputer(actor, bot.id, mode), switched: true };
  } catch (error) {
    // Removing the bot mid-switch also deletes its dedicated computer.
    if (isRecordNotFound(error)) throw new ClientError("NOT_FOUND", "Not Found");
    throw error;
  } finally {
    await deps.prisma.bot.updateMany({
      where: { id: bot.id },
      data: { computerSwitching: false },
    });
  }
}
