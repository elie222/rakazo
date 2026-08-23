import { type JobPublisher, runContinueJob } from "@rakazo/adapter-kit";
import { toComputerRef } from "@rakazo/adapters";
import {
  type Actor,
  GROUP_MEMBER_MIN,
  type GroupMember,
  type ThreadSnapshot,
} from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES, projectMessages, resolveGroupTargetBotIds } from "@rakazo/core";
import {
  appendEventInTransaction,
  createGroupRepos,
  createRepos,
  createThreadMessageInTransaction,
  IsolationError,
  lockOwnedGroup,
  type Prisma,
  type PrismaClient,
  type ThreadEvents,
  touchGroupUpdatedAt,
} from "@rakazo/db";
import {
  buildSendPrompt,
  buildUserMessageBlocks,
  resolveGroupSendAttachments,
  resolveSendAttachments,
} from "./artifacts.js";
import { toComputerStatus } from "./computer-status.js";
import { withSerializableRetry } from "./serializable-retry.js";
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

function sendRunClientNonce(
  clientNonce: string | undefined,
  messageId: string,
  botId?: string,
): string | undefined {
  if (!clientNonce) return undefined;
  return botId ? `send:${messageId}:${botId}` : `send:${messageId}`;
}

async function enqueueRunsNeedingContinue(
  jobs: JobPublisher,
  runs: Array<{ id: string; status: string }>,
) {
  await Promise.all(
    runs
      .filter((run) => RUNS_NEEDING_CONTINUE.has(run.status))
      .map((run) =>
        jobs.enqueue(runContinueJob(run.id)).catch((error) => {
          // The queued run is durable; the reconciler repairs a missed immediate wake.
          console.error("thread send enqueue", error);
        }),
      ),
  );
}

async function findSendReceipt(prisma: PrismaClient, threadId: string, clientNonce: string) {
  return prisma.message.findUnique({
    where: { threadId_clientNonce: { threadId, clientNonce } },
    include: { sourceRuns: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } },
  });
}

async function replayExistingSend(
  deps: { prisma: PrismaClient; events: ThreadEvents; jobs: JobPublisher },
  threadId: string,
  clientNonce: string | undefined,
) {
  if (!clientNonce) return null;
  const message = await findSendReceipt(deps.prisma, threadId, clientNonce);
  if (!message || message.sourceRuns.length === 0) return null;
  await enqueueRunsNeedingContinue(deps.jobs, message.sourceRuns);
  const latestEvent = await deps.prisma.event.findFirst({
    where: { threadId },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  if (latestEvent) {
    await deps.events.notify(threadId, latestEvent.seq).catch((error) => {
      // Subscribers catch up from the durable event cursor after a missed realtime wake.
      console.error("thread send realtime notification", error);
    });
  }
  return sendResult(message, message.sourceRuns);
}

function sendResult(message: { seq: number }, runs: Array<{ id: string; taskId: string }>) {
  const first = runs[0];
  if (!first) throw new IsolationError("Send did not create a run");
  return {
    taskId: first.taskId,
    runId: first.id,
    seq: message.seq,
    runIds: runs.map((run) => run.id),
  };
}

async function cancelSupersededQueuedRuns(
  tx: Prisma.TransactionClient,
  input: { threadId: string; botIds: string[]; keepRunIds: string[] },
) {
  const superseded = await tx.run.findMany({
    where: {
      threadId: input.threadId,
      botId: { in: input.botIds },
      status: "queued",
      id: { notIn: input.keepRunIds },
    },
    select: { id: true, taskId: true },
  });
  if (superseded.length === 0) return;
  const now = new Date();
  await tx.run.updateMany({
    where: { id: { in: superseded.map((run) => run.id) } },
    data: { status: "cancelled", completedAt: now },
  });
  await tx.task.updateMany({
    where: { id: { in: superseded.map((run) => run.taskId) } },
    data: { status: "cancelled" },
  });
}

async function lockAndLoadGroupMembers(
  tx: Prisma.TransactionClient,
  actor: Actor,
  target: Extract<ThreadTarget, { kind: "group" }>,
) {
  await lockOwnedGroup(tx, actor, target.groupId);
  const group = await tx.chatGroup.findFirst({
    where: {
      id: target.groupId,
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      thread: { id: target.threadId },
    },
    include: {
      members: {
        where: { bot: { archivedAt: null } },
        include: { bot: { select: { id: true, name: true, color: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!group || group.members.length < GROUP_MEMBER_MIN) throw new IsolationError();
  return group.members.map((member) => ({
    botId: member.bot.id,
    name: member.bot.name,
    color: member.bot.color,
  }));
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
    const group = await groupRepos.getGroupTarget(actor, input.groupId);
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
  target: ThreadTarget,
): Promise<ThreadSnapshot> {
  if (target.kind === "bot") {
    const [messagePage, last, run] = await Promise.all([
      loadMessagePage(deps.prisma, target.threadId, undefined, THREAD_MESSAGE_PAGE_SIZE),
      deps.prisma.event.findFirst({
        where: { threadId: target.threadId },
        orderBy: { seq: "desc" },
        select: { seq: true },
      }),
      deps.prisma.run.findFirst({
        where: {
          botId: target.botId,
          status: { in: [...ACTIVE_RUN_STATUSES] },
        },
        orderBy: { createdAt: "desc" },
      }),
    ]);
    const liveEvents = run
      ? await deps.prisma.event.findMany({
          where: {
            threadId: target.threadId,
            runId: run.id,
            type: { in: ["thread.progress", "thread.subagent", "agent.tool.called"] },
          },
          orderBy: { seq: "asc" },
        })
      : [];
    return {
      botId: target.botId,
      threadId: target.threadId,
      cursor: last?.seq ?? -1,
      messages: messagesWithLiveEvents(messagePage.messages, liveEvents),
      olderCursor: messagePage.olderCursor,
      run: run ? mapRun(run) : null,
      computer: toComputerStatus(target.botId, target.bot.computer),
    };
  }

  const [messagePage, last, activeRuns] = await Promise.all([
    loadMessagePage(deps.prisma, target.threadId, undefined, THREAD_MESSAGE_PAGE_SIZE),
    deps.prisma.event.findFirst({
      where: { threadId: target.threadId },
      orderBy: { seq: "desc" },
      select: { seq: true },
    }),
    deps.prisma.run.findMany({
      where: {
        threadId: target.threadId,
        status: { in: [...ACTIVE_RUN_STATUSES] },
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  const liveEvents =
    activeRuns.length > 0
      ? await deps.prisma.event.findMany({
          where: {
            threadId: target.threadId,
            runId: { in: activeRuns.map((run) => run.id) },
            type: { in: ["thread.progress", "thread.subagent", "agent.tool.called"] },
          },
          orderBy: { seq: "asc" },
        })
      : [];
  return {
    groupId: target.groupId,
    groupName: target.groupName,
    members: target.members,
    threadId: target.threadId,
    cursor: last?.seq ?? -1,
    messages: messagesWithLiveEvents(messagePage.messages, liveEvents),
    olderCursor: messagePage.olderCursor,
    run: activeRuns[0] ? mapRun(activeRuns[0]) : null,
    activeRuns: activeRuns.map(mapRun),
  };
}

function messagesWithLiveEvents(
  persisted: ThreadSnapshot["messages"],
  liveEvents: Parameters<typeof projectMessages>[0],
) {
  const live = projectMessages(liveEvents).filter((message) => {
    if (message.blocks.some((block) => block.kind === "progress" || block.kind === "steps")) {
      return true;
    }
    if (!message.id.startsWith("subagent:")) return false;
    return !persisted.some((row) =>
      row.blocks.some(
        (block) => block.kind === "subagent" && message.id === `subagent:${block.agentId}`,
      ),
    );
  });
  return [...persisted, ...live];
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
  const existing = await replayExistingSend(deps, target.threadId, input.clientNonce);
  if (existing) return existing;

  const commit = () =>
    deps.prisma.$transaction(async (tx) => {
      if (input.replyToMessageId) {
        const reply = await tx.message.findFirst({
          where: { id: input.replyToMessageId, threadId: target.threadId },
          select: { id: true },
        });
        if (!reply) throw new IsolationError();
      }

      if (target.kind === "bot") {
        const { blocks: attachmentBlocks, artifacts } = await resolveSendAttachments(
          { prisma: tx },
          actor,
          target.botId,
          input.artifactIds,
        );
        const blocks = buildUserMessageBlocks(input.text, attachmentBlocks);
        const message = await createThreadMessageInTransaction(tx, {
          threadId: target.threadId,
          role: "user",
          blocks,
          replyToMessageId: input.replyToMessageId,
          clientNonce: input.clientNonce,
        });
        const task = await tx.task.create({
          data: {
            workspaceId: actor.workspaceId,
            botId: target.botId,
            threadId: target.threadId,
            userId: actor.userId,
            prompt: buildSendPrompt(input.text, artifacts),
            status: "queued",
          },
        });
        const run = await tx.run.create({
          data: {
            workspaceId: actor.workspaceId,
            botId: target.botId,
            threadId: target.threadId,
            taskId: task.id,
            userId: actor.userId,
            status: "queued",
            trigger: "user",
            clientNonce: sendRunClientNonce(input.clientNonce, message.id),
            sourceMessageId: message.id,
          },
        });
        await tx.message.update({ where: { id: message.id }, data: { runId: run.id } });
        await cancelSupersededQueuedRuns(tx, {
          threadId: target.threadId,
          botIds: [target.botId],
          keepRunIds: [run.id],
        });
        const event = await appendEventInTransaction(tx, {
          workspaceId: actor.workspaceId,
          threadId: target.threadId,
          botId: target.botId,
          type: "thread.message.created",
          runId: run.id,
          payload: {
            messageId: message.id,
            role: "user",
            blocks,
            replyToMessageId: input.replyToMessageId,
          },
        });
        return { message, runs: [run], eventSeq: event.seq };
      }

      const members = await lockAndLoadGroupMembers(tx, actor, target);
      const memberBotIds = members.map((member) => member.botId);
      const targetBotIds = resolveGroupTargetBotIds({
        text: input.text ?? "",
        members: members.map((member) => ({ id: member.botId, name: member.name })),
        explicitMentions: input.mentions,
      });
      const { blocks: attachmentBlocks, artifacts } = await resolveGroupSendAttachments(
        { prisma: tx },
        actor,
        target.groupId,
        memberBotIds,
        input.artifactIds,
      );
      const blocks = buildUserMessageBlocks(input.text, attachmentBlocks);
      const message = await createThreadMessageInTransaction(tx, {
        threadId: target.threadId,
        role: "user",
        blocks,
        replyToMessageId: input.replyToMessageId,
        clientNonce: input.clientNonce,
      });
      const runs: Array<{ id: string; taskId: string; botId: string; status: string }> = [];
      for (const botId of targetBotIds) {
        const task = await tx.task.create({
          data: {
            workspaceId: actor.workspaceId,
            botId,
            threadId: target.threadId,
            userId: actor.userId,
            prompt: buildSendPrompt(input.text, artifacts),
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
            clientNonce: sendRunClientNonce(input.clientNonce, message.id, botId),
            sourceMessageId: message.id,
          },
        });
        runs.push(run);
      }
      const firstRun = runs[0];
      if (!firstRun) throw new IsolationError("Group send did not resolve a target");
      await tx.message.update({ where: { id: message.id }, data: { runId: firstRun.id } });
      await cancelSupersededQueuedRuns(tx, {
        threadId: target.threadId,
        botIds: targetBotIds,
        keepRunIds: runs.map((run) => run.id),
      });
      await touchGroupUpdatedAt(tx, target.groupId);
      const event = await appendEventInTransaction(tx, {
        workspaceId: actor.workspaceId,
        threadId: target.threadId,
        botId: firstRun.botId,
        type: "thread.message.created",
        runId: firstRun.id,
        payload: {
          messageId: message.id,
          role: "user",
          blocks,
          replyToMessageId: input.replyToMessageId,
        },
      });
      return { message, runs, eventSeq: event.seq };
    });

  const committed = await withSerializableRetry(commit).catch(async (error) => {
    const winner = await replayExistingSend(deps, target.threadId, input.clientNonce);
    if (winner) return { replay: winner } as const;
    throw error;
  });
  if ("replay" in committed) return committed.replay;
  await deps.events.notify(target.threadId, committed.eventSeq).catch((error) => {
    // Subscribers catch up from the durable event cursor after a missed realtime wake.
    console.error("thread send realtime notification", error);
  });
  await enqueueRunsNeedingContinue(deps.jobs, committed.runs);
  return sendResult(committed.message, committed.runs);
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
    const botsWithScreens = botIds.length
      ? await deps.prisma.bot.findMany({
          where: {
            id: { in: botIds },
            workspaceId: actor.workspaceId,
            userId: actor.userId,
          },
          select: {
            id: true,
            computer: { select: { homeKey: true, kind: true, providerRef: true } },
          },
        })
      : [];
    await deps.prisma.computerExecutionLease.deleteMany({ where: { botId: { in: botIds } } });
    await deps.prisma.computer.updateMany({
      where: { executionBotId: { in: botIds } },
      data: {
        executionRunId: null,
        executionBotId: null,
        executionLeaseExpiresAt: null,
      },
    });
    await Promise.all(
      botsWithScreens.map(async (bot) => {
        if (!bot.computer?.providerRef) return;
        await deps.sandbox
          .releaseScreen?.(toComputerRef(bot.computer), {
            operationId: "stop",
            traceId: "stop",
            workspaceId: actor.workspaceId,
            userId: actor.userId,
            botId: bot.id,
            signal: new AbortController().signal,
          })
          .catch(() => undefined);
      }),
    );
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
      unread: { not: unread },
    },
    data: { unread },
  });
  if (result.count > 1) throw new IsolationError();
}
