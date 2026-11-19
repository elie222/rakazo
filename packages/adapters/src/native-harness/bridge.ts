import { createAdapterContext } from "@rakazo/adapter-kit";
import type { Run } from "@rakazo/db";
import { bridgeInputSchemas } from "@rakazo/native-runtime/bridge-tools";
import { messageBot } from "./../messaging/bot-messages.js";
import type { ExecutorDeps } from "./../runs/executor/executor-deps.js";

/** Native observations never enter here. The process broker asks for each effect's approval. */
export async function executeNativeBridgeTool(
  deps: ExecutorDeps,
  run: Run,
  call: { id: string; name: string; input: Record<string, unknown> },
) {
  const member = await deps.prisma.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: run.spaceId, userId: run.userId } },
  });
  const bot = await deps.prisma.bot.findFirst({ where: { id: run.botId, spaceId: run.spaceId } });
  const active = await deps.prisma.run.findFirst({
    where: {
      id: run.id,
      userId: run.userId,
      status: "running",
      leaseOwner: deps.runLease?.owner,
      leaseFence: deps.runLease?.fence,
    },
  });
  if (!member || !bot || !active) return { error: "Tool authorization expired" };
  if (bot.disabledBuiltinTools.includes(call.name)) return { error: "Tool unavailable" };
  if (call.name === "recall_memory") {
    const input = bridgeInputSchemas.recall_memory.safeParse(call.input);
    if (!input.success) return { error: "Invalid tool arguments" };
    return {
      results: await deps.memory.search(
        { ...input.data, scope: "bot", botId: bot.id },
        createAdapterContext(run, bot.id, `native:${run.id}:${call.id}`),
      ),
    };
  }
  if (call.name === "message_bot") {
    const input = bridgeInputSchemas.message_bot.safeParse(call.input);
    if (!input.success) return { error: "Invalid tool arguments" };
    return messageBot(deps, run, bot, {
      ...input.data,
      deliveryKey: `native:${run.id}:${call.id}`,
    });
  }
  return { error: "Tool unavailable in this execution" };
}
