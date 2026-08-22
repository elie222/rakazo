import { rm } from "node:fs/promises";
import type {
  AdapterContext,
  AgentHomeStore,
  ArtifactStore,
  JobPublisher,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { routineJobKey, runContinueJob, runJobKey } from "@rakazo/adapter-kit";
import type { Actor, Bot } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import {
  computerScopeKey,
  createRepos,
  createThreadMessageInTransaction,
  type PrismaClient,
} from "@rakazo/db";
import { toComputerRef } from "./computer-support.js";
import { checkpointAndRecordComputerWorkspace } from "./computer-workspace.js";
import { resolveAgentHomePath } from "./home.js";

export function confirmSpawnedBotName(confirmName: string, botName: string) {
  if (confirmName !== botName) {
    return {
      ok: false as const,
      error: "confirm_name must exactly match the bot's name. Refusing to archive.",
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

type BotLifecycleDeps = {
  prisma: PrismaClient;
  sandbox: SandboxProvider;
  home: AgentHomeStore;
  jobs: JobPublisher;
  dataDir?: string;
  artifacts?: ArtifactStore;
};

type LifecycleBot = {
  id: string;
  workspaceId: string;
  name: string;
  archivedAt: Date | null;
  computerId?: string | null;
};

export async function archiveSpawnedBot(
  deps: BotLifecycleDeps,
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
    return { error: "confirm_name is required. Refusing to archive." };
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
    return { error: "That bot was not created by this bot. Refusing to archive." };
  }
  if (!input.botId && matches.length === 0) {
    return { error: `This bot did not create a bot named "${confirmName}". Refusing to archive.` };
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
    return { error: "A bot cannot archive itself with archive_bot." };
  }

  await archiveBot(deps, target, context);
  return { ok: true as const, botId: target.id, name: target.name };
}

export async function archiveBot(
  deps: BotLifecycleDeps,
  bot: LifecycleBot,
  context: AdapterContext,
) {
  const [dedicated, activeRuns, activeRoutines] = await Promise.all([
    deps.prisma.computer.findUnique({
      where: { scopeKey: computerScopeKey("dedicated", bot.workspaceId, bot.id) },
    }),
    deps.prisma.run.findMany({
      where: { botId: bot.id, status: { in: [...ACTIVE_RUN_STATUSES] } },
      select: { id: true },
    }),
    deps.prisma.routine.findMany({
      where: { botId: bot.id, active: true },
      select: { id: true },
    }),
  ]);
  const runIds = activeRuns.map((run) => run.id);
  const now = new Date();
  await deps.prisma.$transaction(async (tx) => {
    await tx.run.updateMany({
      where: { id: { in: runIds } },
      data: { status: "cancelled", completedAt: now },
    });
    await tx.task.updateMany({
      where: { runs: { some: { id: { in: runIds } } } },
      data: { status: "cancelled" },
    });
    await tx.routine.updateMany({
      where: { botId: bot.id },
      data: { active: false, nextRunAt: null },
    });
    await tx.computerExecutionLease.deleteMany({ where: { botId: bot.id } });
    await tx.computer.updateMany({
      where: {
        OR: [{ controlBotId: bot.id }, { executionBotId: bot.id }],
      },
      data: releasedComputerLease(),
    });
    if (dedicated) {
      await tx.computer.updateMany({
        where: { id: dedicated.id, state: { not: "running" } },
        data: { state: "stopped" },
      });
    }
    await tx.bot.update({
      where: { id: bot.id },
      data: { archivedAt: bot.archivedAt ?? now, pinned: false },
    });
  });
  await Promise.allSettled([
    ...activeRuns.map((run) => deps.jobs.cancel(runJobKey(run.id))),
    ...activeRoutines.map((routine) => deps.jobs.cancel(routineJobKey(routine.id))),
  ]);
  await releaseTeamComputerScreen(deps, bot, dedicated?.id, context);
  const currentDedicated = dedicated
    ? await deps.prisma.computer.findUnique({ where: { id: dedicated.id } })
    : null;
  if (currentDedicated?.providerRef && currentDedicated.state === "running") {
    const ref = toComputerRef(currentDedicated);
    await checkpointAndRecordComputerWorkspace(deps, currentDedicated, ref, context);
    await deps.sandbox.stop(ref, context);
    await deps.prisma.computer.updateMany({
      where: {
        id: currentDedicated.id,
        state: "running",
        providerRef: currentDedicated.providerRef,
      },
      data: { state: "stopped" },
    });
  }
}

export async function destroyBot(
  deps: BotLifecycleDeps,
  bot: LifecycleBot,
  context: AdapterContext,
  options: { deleteMemories: boolean },
) {
  const [dedicated, activeRuns, routines, artifactRows] = await Promise.all([
    deps.prisma.computer.findUnique({
      where: { scopeKey: computerScopeKey("dedicated", bot.workspaceId, bot.id) },
    }),
    deps.prisma.run.findMany({
      where: { botId: bot.id, status: { in: [...ACTIVE_RUN_STATUSES] } },
      select: { id: true },
    }),
    deps.prisma.routine.findMany({ where: { botId: bot.id }, select: { id: true } }),
    deps.prisma.artifact.findMany({
      where: { botId: bot.id, workspaceId: bot.workspaceId },
      select: { storageKey: true },
    }),
  ]);
  const runIds = activeRuns.map((run) => run.id);
  await deps.prisma.run.updateMany({
    where: { id: { in: runIds } },
    data: { status: "cancelled", completedAt: new Date() },
  });
  await Promise.allSettled([
    ...activeRuns.map((run) => deps.jobs.cancel(runJobKey(run.id))),
    ...routines.map((routine) => deps.jobs.cancel(routineJobKey(routine.id))),
  ]);
  await releaseTeamComputerScreen(deps, bot, dedicated?.id, context);
  if (dedicated?.providerRef) {
    await deps.sandbox.destroy(toComputerRef(dedicated), context).catch(() => undefined);
  }
  await deps.prisma.$transaction(async (tx) => {
    await tx.computerExecutionLease.deleteMany({ where: { botId: bot.id } });
    await tx.computer.updateMany({
      where: {
        ...(dedicated ? { id: { not: dedicated.id } } : {}),
        OR: [{ controlBotId: bot.id }, { executionBotId: bot.id }],
      },
      data: releasedComputerLease(),
    });
    if (!options.deleteMemories) {
      const directory = archivedMemoryDirectory(bot.name, bot.id);
      await tx.$executeRaw`
        UPDATE "memory_documents"
        SET "botId" = NULL,
            "scope" = 'user',
            "path" = ${directory} || '/' || "path",
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "botId" = ${bot.id}
      `;
    }
    await tx.botDeletion.create({
      data: {
        id: bot.id,
        workspaceId: bot.workspaceId,
        name: bot.name,
        deletedByUserId: context.userId,
        memoriesPreserved: !options.deleteMemories,
      },
    });
    await tx.bot.delete({ where: { id: bot.id } });
    if (dedicated) await tx.computer.delete({ where: { id: dedicated.id } });
  });
  if (dedicated) {
    await rm(resolveAgentHomePath(deps.home, dedicated.homeKey, deps.dataDir ?? "./data"), {
      recursive: true,
      force: true,
    }).catch(() => undefined);
  }
  const artifactStore = deps.artifacts;
  if (artifactStore) {
    await Promise.all(
      artifactRows.map((artifact) => artifactStore.remove(artifact.storageKey, context)),
    );
  }
}

function archivedMemoryDirectory(name: string, botId: string) {
  const safeName = name.replace(/[\\/]/g, "-").trim() || "Bot";
  return `Archived bots/${safeName} (${botId})`;
}

function releasedComputerLease() {
  return {
    controlHolder: "none" as const,
    controlLeaseId: null,
    controlLeaseExpiresAt: null,
    controlBotId: null,
    executionRunId: null,
    executionBotId: null,
    executionLeaseExpiresAt: null,
  };
}

async function releaseTeamComputerScreen(
  deps: BotLifecycleDeps,
  bot: LifecycleBot,
  dedicatedId: string | undefined,
  context: AdapterContext,
) {
  if (!bot.computerId || bot.computerId === dedicatedId) return;
  const computer = await deps.prisma.computer.findUnique({ where: { id: bot.computerId } });
  if (!computer?.providerRef) return;
  await deps.sandbox.releaseScreen?.(toComputerRef(computer), context).catch(() => undefined);
}
