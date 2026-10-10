import { randomUUID } from "node:crypto";
import { BOT_INSTRUCTIONS_MAX_LENGTH, InstructionVersionSchema } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { Prisma, PrismaClient } from "./client.js";

export function validateInstructionProposal(args: Record<string, unknown>, trigger: string): void {
  if (!["user", "routine", "follow_up", "call_end"].includes(trigger)) {
    throw new Error("Instruction updates are blocked for externally triggered runs.");
  }
  if (
    typeof args.instructions !== "string" ||
    args.instructions.length > BOT_INSTRUCTIONS_MAX_LENGTH ||
    typeof args.reason !== "string" ||
    !args.reason.trim() ||
    args.reason.length > 500 ||
    Object.keys(args).some((key) => key !== "instructions" && key !== "reason")
  ) {
    throw new Error("Invalid instruction proposal.");
  }
}

/** Serialize proposals across threads and workers; terminal runs release their reservation. */
export async function reserveInstructionProposal(
  prisma: PrismaClient,
  botId: string,
  runId: string,
) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM bots WHERE id = ${botId} FOR UPDATE`;
    const bot = await tx.bot.findUniqueOrThrow({ where: { id: botId } });
    if (bot.pendingInstructionsRunId && bot.pendingInstructionsRunId !== runId) {
      const pending = await tx.run.findFirst({
        where: {
          id: bot.pendingInstructionsRunId,
          status: { in: [...ACTIVE_RUN_STATUSES] },
        },
      });
      if (pending) throw new Error("This bot already has a pending instruction proposal.");
    }
    await tx.bot.update({ where: { id: botId }, data: { pendingInstructionsRunId: runId } });
    return bot;
  });
}

/** All instruction writers use the same row lock and bounded history. */
export async function writeBotInstructions(
  tx: Prisma.TransactionClient,
  input: {
    botId: string;
    instructions?: string;
    reason: string;
    versionId?: string;
    expectedInstructions?: string;
    proposalRunId?: string;
    requireSelfUpdate?: boolean;
  },
) {
  await tx.$queryRaw`SELECT id FROM bots WHERE id = ${input.botId} FOR UPDATE`;
  const bot = await tx.bot.findUniqueOrThrow({ where: { id: input.botId } });
  if (input.requireSelfUpdate && !bot.selfUpdateInstructions)
    throw new Error("Self updates are disabled.");
  if (input.expectedInstructions !== undefined && bot.instructions !== input.expectedInstructions) {
    throw new Error("Instructions changed; review the current instructions first.");
  }
  const history = InstructionVersionSchema.array().parse(bot.instructionHistory);
  if (
    input.versionId &&
    input.expectedInstructions !== undefined &&
    history[0]?.id !== input.versionId
  )
    throw new Error("Instructions changed; review the current instructions first.");
  const instructions = input.versionId
    ? history.find((version) => version.id === input.versionId)?.instructions
    : input.instructions;
  if (instructions === undefined || instructions.length > BOT_INSTRUCTIONS_MAX_LENGTH) {
    throw new Error("Instruction version is unavailable or too large.");
  }
  if (instructions === bot.instructions) {
    if (input.proposalRunId === bot.pendingInstructionsRunId)
      await tx.bot.update({
        where: { id: bot.id },
        data: { pendingInstructionsRunId: null },
      });
    return null;
  }
  const version = {
    id: randomUUID(),
    instructions: bot.instructions,
    reason: input.reason,
    createdAt: new Date().toISOString(),
  };
  await tx.bot.update({
    where: { id: bot.id },
    data: {
      instructions,
      instructionHistory: [version, ...history].slice(0, 20),
      ...(input.proposalRunId === bot.pendingInstructionsRunId
        ? { pendingInstructionsRunId: null }
        : {}),
    },
  });
  return version.id;
}
