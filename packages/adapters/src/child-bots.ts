import { rm } from "node:fs/promises";
import type {
  AdapterContext,
  AgentHomeStore,
  JobPublisher,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { Actor, Bot } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import {
  computerScopeKey,
  createRepos,
  createThreadMessageInTransaction,
  type PrismaClient,
} from "@rakazo/db";
import { toComputerRef } from "./computer-support.js";
import { resolveAgentHomePath } from "./home.js";

export function confirmSpawnedBotName(confirmName: string, botName: string) {
  if (confirmName !== botName) {
    return {
      ok: false as const,
      error:
        "confirm_name must exactly match the bot's name. Refusing to delete. This is permanent — double-check before retrying.",
    };
  }
  return { ok: true as const };
}

export async function spawnBot(
  deps: {
    prisma: PrismaClient;
    jobs: JobPublisher;
  },
  input: {
    spawnedBy: {
      id: string;
      name: string;
      workspaceId: string;
      userId: string;
    };
    runId: string;
    spawnKey: string;
    name: string;
    title?: string;
    instructions?: string;
    prompt?: string;
  },
) {
  const name = input.name.trim();
  if (!name) return { error: "Bot name is required." };

  const actor: Actor = {
    userId: input.spawnedBy.userId,
    workspaceId: input.spawnedBy.workspaceId,
    email: "",
    isDeploymentOwner: false,
  };
  let duplicate = false;
  let created: Pick<Bot, "id" | "name" | "title" | "threadId">;
  try {
    created = await createRepos(deps.prisma).createBot(actor, {
      name,
      title: (input.title ?? "").trim(),
      description: "",
      instructions: (input.instructions ?? "").trim(),
      notifyOnFinish: true,
      parentBotId: input.spawnedBy.id,
      spawnKey: input.spawnKey,
      initialMessage: {
        role: "system",
        blocks: [{ kind: "meta", text: `Created by ${input.spawnedBy.name}` }],
        runId: input.runId,
      },
    });
  } catch (error) {
    const existing = await deps.prisma.bot.findUnique({
      where: {
        workspaceId_spawnKey: {
          workspaceId: input.spawnedBy.workspaceId,
          spawnKey: input.spawnKey,
        },
      },
      include: { thread: true },
    });
    if (!existing) throw error;
    if (!existing.thread) throw new Error(`Spawned bot ${existing.id} is missing its thread`);
    duplicate = true;
    created = {
      id: existing.id,
      name: existing.name,
      title: existing.title,
      threadId: existing.thread.id,
    };
  }

  const prompt = (input.prompt ?? "").trim();
  if (prompt) {
    const run = await ensureSpawnRun(deps.prisma, {
      workspaceId: input.spawnedBy.workspaceId,
      userId: input.spawnedBy.userId,
      botId: created.id,
      threadId: created.threadId,
      sourceRunId: input.runId,
      spawnKey: input.spawnKey,
      prompt,
    });
    await deps.jobs
      .enqueue(runContinueJob(run.id))
      .catch((error) => console.error("spawned bot enqueue", error));
  }

  return {
    ok: true as const,
    ...(duplicate ? { duplicate: true as const } : {}),
    botId: created.id,
    name: created.name,
    title: created.title,
    threadId: created.threadId,
  };
}

async function ensureSpawnRun(
  prisma: PrismaClient,
  input: {
    workspaceId: string;
    userId: string;
    botId: string;
    threadId: string;
    sourceRunId: string;
    spawnKey: string;
    prompt: string;
  },
) {
  const clientNonce = `spawn:${input.spawnKey}`;
  const where = {
    workspaceId_clientNonce: {
      workspaceId: input.workspaceId,
      clientNonce,
    },
  } as const;
  const existing = await prisma.run.findUnique({ where });
  if (existing) return existing;

  try {
    return await prisma.$transaction(async (tx) => {
      await createThreadMessageInTransaction(tx, {
        threadId: input.threadId,
        role: "user",
        blocks: [{ kind: "text", text: input.prompt }],
        runId: input.sourceRunId,
      });
      const task = await tx.task.create({
        data: {
          workspaceId: input.workspaceId,
          botId: input.botId,
          threadId: input.threadId,
          userId: input.userId,
          prompt: input.prompt,
          status: "queued",
        },
      });
      return tx.run.create({
        data: {
          workspaceId: input.workspaceId,
          botId: input.botId,
          threadId: input.threadId,
          taskId: task.id,
          userId: input.userId,
          status: "queued",
          trigger: "spawn",
          clientNonce,
        },
      });
    });
  } catch (error) {
    const winner = await prisma.run.findUnique({ where });
    if (winner) return winner;
    throw error;
  }
}

export async function deleteSpawnedBot(
  deps: {
    prisma: PrismaClient;
    sandbox: SandboxProvider;
    home: AgentHomeStore;
    dataDir?: string;
  },
  input: {
    spawnedByBotId: string;
    userId: string;
    workspaceId: string;
    confirmName: string;
    botId?: string;
  },
  context: AdapterContext,
) {
  const confirmName = input.confirmName.trim();
  if (!confirmName) {
    return { error: "confirm_name is required. Refusing to delete." };
  }

  const spawned = await deps.prisma.bot.findMany({
    where: {
      parentBotId: input.spawnedByBotId,
      userId: input.userId,
      workspaceId: input.workspaceId,
    },
  });
  const matches = input.botId
    ? spawned.filter((bot) => bot.id === input.botId)
    : spawned.filter((bot) => bot.name === confirmName);

  if (input.botId && matches.length === 0) {
    return { error: "That bot was not created by this bot. Refusing to delete." };
  }
  if (!input.botId && matches.length === 0) {
    return { error: `This bot did not create a bot named "${confirmName}". Refusing to delete.` };
  }
  if (!input.botId && matches.length > 1) {
    return {
      error: `More than one bot is named "${confirmName}". Pass bot_id as well as confirm_name.`,
    };
  }

  const target = matches[0]!;
  const confirmed = confirmSpawnedBotName(confirmName, target.name);
  if (!confirmed.ok) return confirmed;
  if (target.id === input.spawnedByBotId) {
    return { error: "A bot cannot delete itself with delete_bot." };
  }

  await destroyBot(deps, target.id, context);
  return { ok: true as const, botId: target.id, name: target.name };
}

export async function destroyBot(
  deps: {
    prisma: PrismaClient;
    sandbox: SandboxProvider;
    home: AgentHomeStore;
    dataDir?: string;
  },
  botId: string,
  context: AdapterContext,
) {
  const bot = await deps.prisma.bot.findUnique({
    where: { id: botId },
  });
  if (!bot) return;
  const dedicated = await deps.prisma.computer.findUnique({
    where: { scopeKey: computerScopeKey("dedicated", bot.workspaceId, botId) },
  });
  await deps.prisma.run.updateMany({
    where: {
      botId,
      status: { in: [...ACTIVE_RUN_STATUSES] },
    },
    data: { status: "cancelled", completedAt: new Date() },
  });
  if (dedicated?.providerRef) {
    await deps.sandbox.destroy(toComputerRef(dedicated), context).catch(() => undefined);
  }
  if (dedicated) {
    await deps.prisma.computer.delete({ where: { id: dedicated.id } }).catch(() => undefined);
  }
  await deps.prisma.bot.delete({ where: { id: botId } }).catch(() => undefined);
  if (dedicated) {
    await rm(resolveAgentHomePath(deps.home, dedicated.homeKey, deps.dataDir ?? "./data"), {
      recursive: true,
      force: true,
    }).catch(() => undefined);
  }
}
