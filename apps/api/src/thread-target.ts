import { type JobPublisher, runContinueJob } from "@rakazo/adapter-kit";
import { toComputerRef } from "@rakazo/adapters";
import {
  type Actor,
  GROUP_MEMBER_MIN,
  type GroupMember,
  type RunStatus,
  type ThreadSnapshot,
} from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  isActive,
  projectMessages,
  resolveGroupTargetBotIds,
  runFailureError,
} from "@rakazo/core";
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
import { resolveBusyBotName, toComputerStatus } from "./computer-status.js";
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

type MentionTargetInput = string | { kind: "bot" | "group" | "routine" | "connector"; id: string };

function splitMentionTargets(mentions: MentionTargetInput[] | undefined) {
  const botMentionIds = new Set<string>();
  const groupMentionIds = new Set<string>();
  const routineMentionIds = new Set<string>();
  const connectorMentionIds = new Set<string>();
  for (const mention of mentions ?? []) {
    if (typeof mention === "string") {
      botMentionIds.add(mention);
      continue;
    }
    if (mention.kind === "bot") botMentionIds.add(mention.id);
    if (mention.kind === "group") groupMentionIds.add(mention.id);
    if (mention.kind === "routine") routineMentionIds.add(mention.id);
    if (mention.kind === "connector") connectorMentionIds.add(mention.id);
  }
  return {
    botMentionIds: [...botMentionIds],
    groupMentionIds: [...groupMentionIds],
    routineMentionIds: [...routineMentionIds],
    connectorMentionIds: [...connectorMentionIds],
  };
}

async function resolveOwnedConnectorDisplayNames(
  tx: Prisma.TransactionClient,
  actor: Actor,
  connectionIds: string[],
) {
  if (!connectionIds.length) return [];
  const rows = await tx.connection.findMany({
    where: {
      id: { in: connectionIds },
      spaceId: actor.spaceId,
      userId: actor.userId,
      status: "connected",
    },
    select: { id: true, displayName: true },
  });
  if (rows.length !== connectionIds.length) throw new IsolationError();
  const byId = new Map(rows.map((row) => [row.id, row.displayName]));
  return connectionIds.map((id) => byId.get(id) ?? "connector");
}

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

export async function cancelSupersededQueuedRuns(
  tx: Prisma.TransactionClient,
  input: { threadId: string; botIds: string[]; keepRunIds: string[] },
) {
  const superseded = await tx.run.findMany({
    where: {
      threadId: input.threadId,
      botId: { in: input.botIds },
      status: "queued",
      OR: [{ trigger: "user", sourceMessage: { role: "user" } }, { trigger: "reaction" }],
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
      spaceId: actor.spaceId,
      userId: actor.userId,
      archivedAt: null,
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
      status: member.bot.runs[0]?.status ?? "idle",
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

export async function threadHead(prisma: PrismaClient, target: ThreadTarget) {
  const latest = await prisma.event.findFirst({
    where: { threadId: target.threadId },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  return { threadId: target.threadId, cursor: latest?.seq ?? -1 };
}

export async function threadSnapshot(
  deps: { prisma: PrismaClient },
  target: ThreadTarget,
): Promise<ThreadSnapshot> {
  // Lock the thread row so messages, the event cursor, active runs, and live
  // progress are read from one consistent commit. A torn Promise.all can
  // otherwise advance the client cursor past thread.message.created while the
  // ask message page still omits it — leaving waiting_input with no AskCard.
  if (target.kind === "bot") {
    const [busyBotName, core] = await Promise.all([
      resolveBusyBotName(deps.prisma, {
        computerId: target.bot.computer?.id,
        botId: target.botId,
        botName: target.bot.name,
      }),
      deps.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR SHARE`;
        const [messagePage, last, run] = await Promise.all([
          loadMessagePage(tx, target.threadId, undefined, THREAD_MESSAGE_PAGE_SIZE),
          tx.event.findFirst({
            where: { threadId: target.threadId },
            orderBy: { seq: "desc" },
            select: { seq: true },
          }),
          tx.run.findFirst({
            where: {
              botId: target.botId,
              threadId: target.threadId,
              trigger: { not: "bot_message" },
              status: { in: [...ACTIVE_RUN_STATUSES, "failed"] },
            },
            orderBy: { createdAt: "desc" },
          }),
        ]);
        const liveEvents =
          run && isActive(run.status as RunStatus)
            ? await tx.event.findMany({
                where: {
                  threadId: target.threadId,
                  runId: run.id,
                  type: { in: ["thread.progress", "thread.subagent", "agent.tool.called"] },
                },
                orderBy: { seq: "asc" },
              })
            : [];
        return { messagePage, last, run, liveEvents };
      }),
    ]);
    return {
      botId: target.botId,
      threadId: target.threadId,
      cursor: core.last?.seq ?? -1,
      messages: messagesWithLiveEvents(core.messagePage.messages, core.liveEvents),
      olderCursor: core.messagePage.olderCursor,
      run: core.run ? mapRun(core.run) : null,
      computer: toComputerStatus(target.botId, target.bot.computer, busyBotName),
    };
  }

  const core = await deps.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR SHARE`;
    const [messagePage, last, activeRuns, recentTerminals] = await Promise.all([
      loadMessagePage(tx, target.threadId, undefined, THREAD_MESSAGE_PAGE_SIZE),
      tx.event.findFirst({
        where: { threadId: target.threadId },
        orderBy: { seq: "desc" },
        select: { seq: true },
      }),
      tx.run.findMany({
        where: {
          threadId: target.threadId,
          trigger: { not: "bot_message" },
          status: { in: [...ACTIVE_RUN_STATUSES] },
        },
        orderBy: { createdAt: "desc" },
      }),
      // Recently updated terminals (completion bumps updatedAt). pickLatestTerminalRun then
      // ranks by completedAt ?? createdAt so null timestamps cannot revive a stale failure.
      tx.run.findMany({
        where: {
          threadId: target.threadId,
          trigger: { not: "bot_message" },
          status: { in: ["failed", "completed", "cancelled"] },
        },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: 50,
      }),
    ]);
    const liveEvents =
      activeRuns.length > 0
        ? await tx.event.findMany({
            where: {
              threadId: target.threadId,
              runId: { in: activeRuns.map((run) => run.id) },
              type: { in: ["thread.progress", "thread.subagent", "agent.tool.called"] },
            },
            orderBy: { seq: "asc" },
          })
        : [];
    return {
      messagePage,
      last,
      activeRuns,
      terminalRun: pickLatestTerminalRun(recentTerminals),
      liveEvents,
    };
  });
  return {
    groupId: target.groupId,
    groupName: target.groupName,
    members: target.members,
    threadId: target.threadId,
    cursor: core.last?.seq ?? -1,
    messages: messagesWithLiveEvents(core.messagePage.messages, core.liveEvents),
    olderCursor: core.messagePage.olderCursor,
    // Match the live reducer: a failed latest terminal stays in run even while siblings are
    // still active or start late. A newer completed/cancelled terminal clears it.
    run:
      core.terminalRun?.status === "failed"
        ? mapRun(core.terminalRun)
        : core.activeRuns[0]
          ? mapRun(core.activeRuns[0])
          : null,
    activeRuns: core.activeRuns.map(mapRun),
  };
}

/** Latest terminal by end time (completedAt, else createdAt), then createdAt, then id. */
function pickLatestTerminalRun<T extends { id: string; createdAt: Date; completedAt: Date | null }>(
  runs: T[],
): T | null {
  if (runs.length === 0) return null;
  return runs.reduce((best, run) => {
    const bestEnd = (best.completedAt ?? best.createdAt).getTime();
    const runEnd = (run.completedAt ?? run.createdAt).getTime();
    if (runEnd !== bestEnd) return runEnd > bestEnd ? run : best;
    if (run.createdAt.getTime() !== best.createdAt.getTime()) {
      return run.createdAt > best.createdAt ? run : best;
    }
    return run.id > best.id ? run : best;
  });
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
  routineId: string | null;
  modelProvider: string | null;
  modelId: string | null;
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: run.id,
    botId: run.botId,
    threadId: run.threadId,
    taskId: run.taskId,
    status: run.status as never,
    trigger: run.trigger as never,
    routineId: run.routineId ?? null,
    modelProvider: run.modelProvider,
    modelId: run.modelId,
    // Same display clamp as live run.failed events so a huge stored error cannot bypass it.
    error:
      run.status === "failed"
        ? runFailureError({ type: "run.failed", payload: { error: run.error } })
        : run.error,
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
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
    mentions?: MentionTargetInput[];
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
        const mentionTargets = splitMentionTargets(input.mentions);
        const { blocks: attachmentBlocks, artifacts } = await resolveSendAttachments(
          { prisma: tx },
          actor,
          target.botId,
          input.artifactIds,
        );
        const connectorNames = await resolveOwnedConnectorDisplayNames(
          tx,
          actor,
          mentionTargets.connectorMentionIds,
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
            spaceId: actor.spaceId,
            botId: target.botId,
            threadId: target.threadId,
            userId: actor.userId,
            prompt: buildSendPrompt(input.text, artifacts, connectorNames),
            status: "queued",
          },
        });
        const run = await tx.run.create({
          data: {
            spaceId: actor.spaceId,
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
          spaceId: actor.spaceId,
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
      const mentionTargets = splitMentionTargets(input.mentions);
      const targetBotIds = resolveGroupTargetBotIds({
        text: input.text ?? "",
        members: members.map((member) => ({ id: member.botId, name: member.name })),
        explicitMentions: mentionTargets.botMentionIds,
      });
      const { blocks: attachmentBlocks, artifacts } = await resolveGroupSendAttachments(
        { prisma: tx },
        actor,
        target.groupId,
        memberBotIds,
        input.artifactIds,
      );
      const connectorNames = await resolveOwnedConnectorDisplayNames(
        tx,
        actor,
        mentionTargets.connectorMentionIds,
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
            spaceId: actor.spaceId,
            botId,
            threadId: target.threadId,
            userId: actor.userId,
            prompt: buildSendPrompt(input.text, artifacts, connectorNames),
            status: "queued",
          },
        });
        const run = await tx.run.create({
          data: {
            spaceId: actor.spaceId,
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
        spaceId: actor.spaceId,
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

export async function reactToThreadMessage(
  deps: { prisma: PrismaClient },
  actor: Actor,
  target: ThreadTarget,
  messageId: string,
  thumbsUp: boolean,
) {
  return deps.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR UPDATE`;
    const [message] = await tx.$queryRaw<
      Array<{ id: string; thumbsUp: boolean }>
    >`SELECT id, "thumbsUp" FROM messages WHERE id = ${messageId} AND "threadId" = ${target.threadId} FOR UPDATE`;
    if (!message) throw new IsolationError();
    if (message.thumbsUp === thumbsUp) {
      return { changed: false, eventSeq: null, runId: null };
    }

    await tx.message.update({ where: { id: message.id }, data: { thumbsUp } });
    const botId = target.kind === "bot" ? target.botId : target.memberBotIds[0];
    if (!botId) throw new IsolationError();

    let run: { id: string; status: string } | null = null;
    if (thumbsUp && target.kind === "bot") {
      const busy = await tx.run.findFirst({
        where: { botId, status: { in: ["running", "queued", "leased"] } },
        select: { id: true },
      });
      if (!busy) {
        const task = await tx.task.create({
          data: {
            spaceId: actor.spaceId,
            botId,
            threadId: target.threadId,
            userId: actor.userId,
            prompt: "The user gave this message a thumbs-up.",
            status: "queued",
          },
        });
        run = await tx.run.create({
          data: {
            spaceId: actor.spaceId,
            botId,
            threadId: target.threadId,
            taskId: task.id,
            userId: actor.userId,
            status: "queued",
            trigger: "reaction",
            sourceMessageId: message.id,
          },
        });
      }
    }

    const event = await appendEventInTransaction(tx, {
      spaceId: actor.spaceId,
      threadId: target.threadId,
      botId,
      type: "thread.message.reaction",
      payload: { messageId: message.id, thumbsUp },
      runId: run?.id,
    });
    return { changed: true, eventSeq: event.seq, runId: run?.id ?? null };
  });
}

export async function stopThreadRuns(
  deps: {
    prisma: PrismaClient;
    sandbox: import("@rakazo/adapter-kit").SandboxProvider;
  },
  actor: Actor,
  target: ThreadTarget,
) {
  const runIds = (
    await deps.prisma.run.findMany({
      where: {
        threadId: target.threadId,
        status: { in: [...ACTIVE_RUN_STATUSES] },
      },
      select: { id: true },
    })
  ).map((run) => run.id);
  await deps.prisma.run.updateMany({
    where: { id: { in: runIds } },
    data: { status: "cancelled", completedAt: new Date() },
  });
  const computers = runIds.length
    ? await deps.prisma.computer.findMany({
        where: { executionRunId: { in: runIds } },
        select: {
          homeKey: true,
          kind: true,
          providerRef: true,
          executionBotId: true,
        },
      })
    : [];
  await deps.prisma.computerExecutionLease.deleteMany({ where: { runId: { in: runIds } } });
  await deps.prisma.computer.updateMany({
    where: { executionRunId: { in: runIds } },
    data: {
      executionRunId: null,
      executionBotId: null,
      executionLeaseExpiresAt: null,
    },
  });
  await Promise.all(
    computers.map(async (computer) => {
      if (!computer.providerRef || !computer.executionBotId) return;
      await deps.sandbox
        .releaseScreen?.(toComputerRef(computer), {
          operationId: "stop",
          traceId: "stop",
          spaceId: actor.spaceId,
          userId: actor.userId,
          botId: computer.executionBotId,
          signal: new AbortController().signal,
        })
        .catch(() => undefined);
    }),
  );
  await deps.prisma.event.deleteMany({
    where: {
      type: "thread.progress",
      runId: { in: runIds },
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
      spaceId: actor.spaceId,
      userId: actor.userId,
      unread: { not: unread },
    },
    data: { unread },
  });
  if (result.count > 1) throw new IsolationError();
}
