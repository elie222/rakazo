import { rm } from "node:fs/promises";
import type {
  AdapterContext,
  AgentHomeStore,
  JobPublisher,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import { createRepos, createThreadMessage, type PrismaClient } from "@rakazo/db";
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
  const created = await createRepos(deps.prisma).createBot(actor, {
    name,
    title: (input.title ?? "").trim(),
    description: "",
    instructions: (input.instructions ?? "").trim(),
    notifyOnFinish: true,
    parentBotId: input.spawnedBy.id,
  });

  const thread = await deps.prisma.thread.findUniqueOrThrow({ where: { botId: created.id } });
  await createThreadMessage(deps.prisma, {
    threadId: thread.id,
    role: "system",
    blocks: [{ kind: "meta", text: `Created by ${input.spawnedBy.name}` }],
    runId: input.runId,
  });

  const prompt = (input.prompt ?? "").trim();
  if (prompt) {
    await createThreadMessage(deps.prisma, {
      threadId: thread.id,
      role: "user",
      blocks: [{ kind: "text", text: prompt }],
      runId: input.runId,
    });
    const task = await deps.prisma.task.create({
      data: {
        workspaceId: input.spawnedBy.workspaceId,
        botId: created.id,
        threadId: thread.id,
        userId: input.spawnedBy.userId,
        prompt,
        status: "queued",
      },
    });
    const run = await deps.prisma.run.create({
      data: {
        workspaceId: input.spawnedBy.workspaceId,
        botId: created.id,
        threadId: thread.id,
        taskId: task.id,
        userId: input.spawnedBy.userId,
        status: "queued",
        trigger: "spawn",
      },
    });
    await deps.jobs.enqueue(runContinueJob(run.id));
  }

  return {
    ok: true as const,
    botId: created.id,
    name: created.name,
    title: created.title,
    threadId: created.threadId,
  };
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
    include: { computer: true },
  });
  if (!bot) return;
  await deps.prisma.run.updateMany({
    where: {
      botId,
      status: { in: [...ACTIVE_RUN_STATUSES] },
    },
    data: { status: "cancelled", completedAt: new Date() },
  });
  if (bot.computer?.providerRef) {
    await deps.sandbox
      .destroy(
        {
          id: bot.computer.providerRef,
          botId,
          kind: bot.computer.kind as never,
          providerRef: bot.computer.providerRef,
        },
        context,
      )
      .catch(() => undefined);
  }
  await deps.prisma.bot.delete({ where: { id: botId } }).catch(() => undefined);
  await rm(resolveAgentHomePath(deps.home, botId, deps.dataDir ?? "./data"), {
    recursive: true,
    force: true,
  }).catch(() => undefined);
}
