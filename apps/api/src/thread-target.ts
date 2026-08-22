import { type JobPublisher, runContinueJob } from "@rakazo/adapter-kit";
import { toComputerRef } from "@rakazo/adapters";
import type { Actor, ComputerStatus, GroupMember, ThreadSnapshot } from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  computerScreenSize,
  projectMessages,
  resolveGroupTargetBotIds,
} from "@rakazo/core";
import {
  createGroupRepos,
  createRepos,
  createThreadMessage,
  createThreadMessageInTransaction,
  IsolationError,
  type PrismaClient,
  type ThreadEvents,
} from "@rakazo/db";
import {
  buildSendPrompt,
  buildUserMessageBlocks,
  resolveGroupSendAttachments,
  resolveSendAttachments,
} from "./artifacts.js";
import { loadMessagePage } from "./thread-message-pages.js";

export type ThreadTarget =
  | {
      kind: "bot";
      botId: string;
      threadId: string;
      bot: Awaited<ReturnType<ReturnType<typeof createRepos>["getBot"]>>;
    }
  | {
      kind: "group";
      groupId: string;
      threadId: string;
      groupName: string;
      members: GroupMember[];
      memberBotIds: string[];
    };

const THREAD_MESSAGE_PAGE_SIZE = 100;
const RUNS_NEEDING_CONTINUE = new Set(["queued"]);

function fanoutRunClientNonce(
  clientNonce: string | undefined,
  botId: string,
  multiTarget: boolean,
): string | undefined {
  if (!clientNonce) return undefined;
  return multiTarget ? `${clientNonce}:${botId}` : clientNonce;
}

function sendNonceKeys(clientNonce: string, memberBotIds?: string[]): string[] {
  const keys = new Set<string>([clientNonce]);
  if (memberBotIds) {
    for (const botId of memberBotIds) {
      keys.add(`${clientNonce}:${botId}`);
    }
  }
  return [...keys];
}

async function findRunsForSendNonce(
  prisma: PrismaClient,
  scope: { workspaceId: string; userId: string; threadId: string },
  clientNonce: string,
  memberBotIds?: string[],
) {
  return prisma.run.findMany({
    where: {
      workspaceId: scope.workspaceId,
      userId: scope.userId,
      threadId: scope.threadId,
      clientNonce: { in: sendNonceKeys(clientNonce, memberBotIds) },
    },
    orderBy: { createdAt: "asc" },
  });
}

async function enqueueRunsNeedingContinue(
  jobs: JobPublisher,
  runs: Array<{ id: string; status: string }>,
) {
  for (const run of runs) {
    if (RUNS_NEEDING_CONTINUE.has(run.status)) {
      await jobs.enqueue(runContinueJob(run.id));
    }
  }
}

export async function resolveThreadTarget(
  prisma: PrismaClient,
  actor: Actor,
  input: { botId?: string; groupId?: string },
): Promise<ThreadTarget> {
  const repos = createRepos(prisma);
  const groupRepos = createGroupRepos(prisma);
  if (input.botId) {
    const bot = await repos.getBot(actor, input.botId);
    if (!bot.thread) throw new IsolationError();
    return {
      kind: "bot",
      botId: bot.id,
      threadId: bot.thread.id,
      bot,
    };
  }
  if (input.groupId) {
    const group = await groupRepos.getGroup(actor, input.groupId);
    if (!group.thread) throw new IsolationError();
    const members = group.members.map((member) => ({
      botId: member.bot.id,
      name: member.bot.name,
      color: member.bot.color,
    }));
    return {
      kind: "group",
      groupId: group.id,
      threadId: group.thread.id,
      groupName: group.name,
      members,
      memberBotIds: members.map((member) => member.botId),
    };
  }
  throw new IsolationError();
}

export async function threadSnapshot(
  deps: { prisma: PrismaClient },
  actor: Actor,
  target: ThreadTarget,
): Promise<ThreadSnapshot> {
  const [messagePage, last] = await Promise.all([
    loadMessagePage(deps.prisma, target.threadId, undefined, THREAD_MESSAGE_PAGE_SIZE),
    deps.prisma.event.findFirst({
      where: { threadId: target.threadId },
      orderBy: { seq: "desc" },
      select: { seq: true },
    }),
  ]);

  if (target.kind === "bot") {
    const [run, bot] = await Promise.all([
      deps.prisma.run.findFirst({
        where: {
          botId: target.botId,
          status: { in: [...ACTIVE_RUN_STATUSES] },
        },
        orderBy: { createdAt: "desc" },
      }),
      createRepos(deps.prisma).getBot(actor, target.botId),
    ]);
    const liveEvents = run
      ? await deps.prisma.event.findMany({
          where: {
            threadId: target.threadId,
            runId: run.id,
            type: { in: ["thread.progress", "thread.subagent"] },
          },
          orderBy: { seq: "asc" },
        })
      : [];
    const projected = projectMessages(liveEvents);
    const persisted = messagePage.messages;
    const live = projected.filter((message) => {
      if (message.blocks.some((block) => block.kind === "progress")) return true;
      if (!message.id.startsWith("subagent:")) return false;
      return !persisted.some((row) =>
        row.blocks.some(
          (block) => block.kind === "subagent" && message.id === `subagent:${block.agentId}`,
        ),
      );
    });
    return {
      botId: target.botId,
      threadId: target.threadId,
      cursor: last?.seq ?? -1,
      messages: [...persisted, ...live],
      olderCursor: messagePage.olderCursor,
      run: run ? mapRun(run) : null,
      computer: toComputerStatus(target.botId, bot.computer),
    };
  }

  const activeRuns = await deps.prisma.run.findMany({
    where: {
      threadId: target.threadId,
      status: { in: [...ACTIVE_RUN_STATUSES] },
    },
    orderBy: { createdAt: "desc" },
  });
  const liveEvents =
    activeRuns.length > 0
      ? await deps.prisma.event.findMany({
          where: {
            threadId: target.threadId,
            runId: { in: activeRuns.map((run) => run.id) },
            type: { in: ["thread.progress", "thread.subagent"] },
          },
          orderBy: { seq: "asc" },
        })
      : [];
  const projected = projectMessages(liveEvents);
  const persisted = messagePage.messages;
  const live = projected.filter((message) => {
    if (message.blocks.some((block) => block.kind === "progress")) return true;
    if (!message.id.startsWith("subagent:")) return false;
    return !persisted.some((row) =>
      row.blocks.some(
        (block) => block.kind === "subagent" && message.id === `subagent:${block.agentId}`,
      ),
    );
  });
  return {
    groupId: target.groupId,
    groupName: target.groupName,
    members: target.members,
    threadId: target.threadId,
    cursor: last?.seq ?? -1,
    messages: [...persisted, ...live],
    olderCursor: messagePage.olderCursor,
    run: activeRuns[0] ? mapRun(activeRuns[0]) : null,
    activeRuns: activeRuns.map(mapRun),
  };
}

function mapRun(run: {
  id: string;
  botId: string;
  threadId: string;
  taskId: string;
  status: string;
  trigger: string;
  modelProvider: string | null;
  modelId: string | null;
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
}) {
  return {
    id: run.id,
    botId: run.botId,
    threadId: run.threadId,
    taskId: run.taskId,
    status: run.status as never,
    trigger: run.trigger as never,
    modelProvider: run.modelProvider,
    modelId: run.modelId,
    error: run.error,
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
  };
}

export async function sendThreadMessage(
  deps: {
    prisma: PrismaClient;
    events: ThreadEvents;
    jobs: JobPublisher;
  },
  actor: Actor,
  target: ThreadTarget,
  input: {
    text?: string;
    artifactIds?: string[];
    mentions?: string[];
    replyToMessageId?: string;
    clientNonce?: string;
  },
) {
  if (input.clientNonce) {
    const existingRuns = await findRunsForSendNonce(
      deps.prisma,
      {
        workspaceId: actor.workspaceId,
        userId: actor.userId,
        threadId: target.threadId,
      },
      input.clientNonce,
      target.kind === "group" ? target.memberBotIds : undefined,
    );
    if (existingRuns.length > 0) {
      await enqueueRunsNeedingContinue(deps.jobs, existingRuns);
      const linked = await deps.prisma.message.findFirst({
        where: { runId: { in: existingRuns.map((run) => run.id) } },
        select: { seq: true },
      });
      return {
        taskId: existingRuns[0]!.taskId,
        runId: existingRuns[0]!.id,
        seq: linked?.seq ?? 0,
        runIds: existingRuns.map((run) => run.id),
      };
    }
  }

  if (input.replyToMessageId) {
    const reply = await deps.prisma.message.findFirst({
      where: { id: input.replyToMessageId, threadId: target.threadId },
    });
    if (!reply) throw new IsolationError();
  }

  if (target.kind === "bot") {
    const { blocks: attachmentBlocks, artifacts } = await resolveSendAttachments(
      deps,
      actor,
      target.botId,
      input.artifactIds,
    );
    const blocks = buildUserMessageBlocks(input.text, attachmentBlocks);
    const prompt = buildSendPrompt(input.text, artifacts);
    const message = await createThreadMessage(deps.prisma, {
      threadId: target.threadId,
      role: "user",
      blocks,
      replyToMessageId: input.replyToMessageId,
    });
    await deps.events.append({
      workspaceId: actor.workspaceId,
      threadId: target.threadId,
      botId: target.botId,
      type: "thread.message.created",
      payload: {
        messageId: message.id,
        role: "user",
        blocks,
        replyToMessageId: input.replyToMessageId,
      },
    });
    const task = await deps.prisma.task.create({
      data: {
        workspaceId: actor.workspaceId,
        botId: target.botId,
        threadId: target.threadId,
        userId: actor.userId,
        prompt,
        status: "queued",
      },
    });
    const run = await deps.prisma.run.create({
      data: {
        workspaceId: actor.workspaceId,
        botId: target.botId,
        threadId: target.threadId,
        taskId: task.id,
        userId: actor.userId,
        status: "queued",
        trigger: "user",
        clientNonce: input.clientNonce,
      },
    });
    await deps.prisma.message.update({
      where: { id: message.id },
      data: { runId: run.id },
    });
    await deps.prisma.run.updateMany({
      where: {
        botId: target.botId,
        status: "queued",
        id: { not: run.id },
      },
      data: { status: "cancelled", completedAt: new Date() },
    });
    await deps.jobs.enqueue(runContinueJob(run.id));
    return { taskId: task.id, runId: run.id, seq: message.seq, runIds: [run.id] };
  }

  const { blocks: attachmentBlocks, artifacts } = await resolveGroupSendAttachments(
    deps,
    actor,
    target.memberBotIds,
    input.artifactIds,
  );
  const blocks = buildUserMessageBlocks(input.text, attachmentBlocks);
  const prompt = buildSendPrompt(input.text, artifacts);
  const targetBotIds = resolveGroupTargetBotIds({
    text: input.text ?? "",
    members: target.members.map((member) => ({ id: member.botId, name: member.name })),
    explicitMentions: input.mentions,
  });
  const fanout = await deps.prisma.$transaction(async (tx) => {
    const message = await createThreadMessageInTransaction(tx, {
      threadId: target.threadId,
      role: "user",
      blocks,
      replyToMessageId: input.replyToMessageId,
    });
    const runIds: string[] = [];
    let firstTaskId = "";
    let firstRunId = "";
    const multiTarget = targetBotIds.length > 1;
    for (const botId of targetBotIds) {
      const task = await tx.task.create({
        data: {
          workspaceId: actor.workspaceId,
          botId,
          threadId: target.threadId,
          userId: actor.userId,
          prompt,
          status: "queued",
        },
      });
      const run = await tx.run.create({
        data: {
          workspaceId: actor.workspaceId,
          botId,
          threadId: target.threadId,
          taskId: task.id,
          userId: actor.userId,
          status: "queued",
          trigger: "user",
          clientNonce: fanoutRunClientNonce(input.clientNonce, botId, multiTarget),
        },
      });
      if (!firstTaskId) {
        firstTaskId = task.id;
        firstRunId = run.id;
      }
      runIds.push(run.id);
    }
    await tx.message.update({
      where: { id: message.id },
      data: { runId: firstRunId || undefined },
    });
    await tx.run.updateMany({
      where: {
        threadId: target.threadId,
        status: "queued",
        id: { notIn: runIds },
      },
      data: { status: "cancelled", completedAt: new Date() },
    });
    await tx.chatGroup.update({
      where: { id: target.groupId },
      data: { updatedAt: new Date() },
    });
    return { message, runIds, firstTaskId, firstRunId };
  });
  const eventBotId = targetBotIds[0] ?? target.memberBotIds[0];
  if (!eventBotId) throw new IsolationError();
  await deps.events.append({
    workspaceId: actor.workspaceId,
    threadId: target.threadId,
    botId: eventBotId,
    type: "thread.message.created",
    payload: {
      messageId: fanout.message.id,
      role: "user",
      blocks,
      replyToMessageId: input.replyToMessageId,
    },
  });
  for (const runId of fanout.runIds) {
    await deps.jobs.enqueue(runContinueJob(runId));
  }
  return {
    taskId: fanout.firstTaskId,
    runId: fanout.firstRunId,
    seq: fanout.message.seq,
    runIds: fanout.runIds,
  };
}

export async function stopThreadRuns(
  deps: {
    prisma: PrismaClient;
    sandbox: import("@rakazo/adapter-kit").SandboxProvider;
  },
  actor: Actor,
  target: ThreadTarget,
) {
  const activeRuns = await deps.prisma.run.findMany({
    where: {
      threadId: target.threadId,
      status: { in: [...ACTIVE_RUN_STATUSES] },
    },
    select: { id: true, botId: true },
  });
  await deps.prisma.run.updateMany({
    where: {
      threadId: target.threadId,
      status: { in: [...ACTIVE_RUN_STATUSES] },
    },
    data: { status: "cancelled", completedAt: new Date() },
  });
  if (target.kind === "bot") {
    await deps.prisma.computerExecutionLease.deleteMany({ where: { botId: target.botId } });
    await deps.prisma.computer.updateMany({
      where: { executionBotId: target.botId },
      data: {
        executionRunId: null,
        executionBotId: null,
        executionLeaseExpiresAt: null,
      },
    });
    if (target.bot.computer?.providerRef) {
      await deps.sandbox
        .releaseScreen?.(toComputerRef(target.bot.computer), {
          operationId: "stop",
          traceId: "stop",
          workspaceId: actor.workspaceId,
          userId: actor.userId,
          botId: target.botId,
          signal: new AbortController().signal,
        })
        .catch(() => undefined);
    }
  } else {
    const botIds = [...new Set(activeRuns.map((run) => run.botId))];
    await deps.prisma.computerExecutionLease.deleteMany({ where: { botId: { in: botIds } } });
    await deps.prisma.computer.updateMany({
      where: { executionBotId: { in: botIds } },
      data: {
        executionRunId: null,
        executionBotId: null,
        executionLeaseExpiresAt: null,
      },
    });
  }
  await deps.prisma.event.deleteMany({
    where: {
      type: "thread.progress",
      runId: { in: activeRuns.map((run) => run.id) },
    },
  });
}

export async function setThreadUnreadState(
  prisma: PrismaClient,
  actor: Actor,
  target: ThreadTarget,
  unread: boolean,
) {
  const result = await prisma.thread.updateMany({
    where: {
      id: target.threadId,
      workspaceId: actor.workspaceId,
      userId: actor.userId,
    },
    data: { unread },
  });
  if (result.count !== 1) throw new IsolationError();
}

function toComputerStatus(
  botId: string,
  computer: {
    kind: string;
    state: string;
    scope: string;
    controlHolder: string;
    controlBotId?: string | null;
    homeRevision: string;
  } | null,
): ComputerStatus {
  const state =
    computer?.state === "suspending"
      ? "running"
      : computer?.state === "stopped" ||
          computer?.state === "booting" ||
          computer?.state === "running" ||
          computer?.state === "suspended" ||
          computer?.state === "error"
        ? computer.state
        : "stopped";
  const screen = computerScreenSize(computer?.kind);
  return {
    botId,
    mode: computer?.scope === "dedicated" ? "dedicated" : "team",
    kind: (computer?.kind ?? "fake") as ComputerStatus["kind"],
    state,
    controlHolder: (computer?.controlHolder ?? "none") as ComputerStatus["controlHolder"],
    controlBotId: computer?.controlBotId ?? null,
    screenAvailable: state === "running" || state === "booting",
    screenWidth: screen.width,
    screenHeight: screen.height,
    homeRevision: computer?.homeRevision ?? null,
    busyBotName: null,
  };
}
