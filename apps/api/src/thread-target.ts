import { type JobPublisher, runContinueJob } from "@rakazo/adapter-kit";
import { notifyDelegationOrigin, toComputerRef } from "@rakazo/adapters";
import {
  type Actor,
  GROUP_MEMBER_MIN,
  type GroupMember,
  type MessageBlock,
  type ThreadSnapshot,
} from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  blocksToAgentHistoryText,
  projectMessages,
  resolveGroupTargetBotIds,
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
              status: { in: [...ACTIVE_RUN_STATUSES] },
            },
            orderBy: { createdAt: "desc" },
          }),
        ]);
        const liveEvents = run
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
    const [messagePage, last, activeRuns] = await Promise.all([
      loadMessagePage(tx, target.threadId, undefined, THREAD_MESSAGE_PAGE_SIZE),
      tx.event.findFirst({
        where: { threadId: target.threadId },
        orderBy: { seq: "desc" },
        select: { seq: true },
      }),
      tx.run.findMany({
        where: {
          threadId: target.threadId,
          status: { in: [...ACTIVE_RUN_STATUSES] },
        },
        orderBy: { createdAt: "desc" },
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
    return { messagePage, last, activeRuns, liveEvents };
  });
  return {
    groupId: target.groupId,
    groupName: target.groupName,
    members: target.members,
    threadId: target.threadId,
    cursor: core.last?.seq ?? -1,
    messages: messagesWithLiveEvents(core.messagePage.messages, core.liveEvents),
    olderCursor: core.messagePage.olderCursor,
    run: core.activeRuns[0] ? mapRun(core.activeRuns[0]) : null,
    activeRuns: core.activeRuns.map(mapRun),
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

const DELEGATION_CONTEXT_MESSAGES = 6;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * "@BotB" anywhere in Bot A's 1:1 chat, typed by the user, delegates the task
 * to an existing peer bot rather than sending to Bot A — "@BotB do X" at the
 * start, or "do X @BotB" / "can you ask @BotB to do X" mid-sentence, all
 * match. Matched against every other bot's exact name (longest first, so
 * "Chief of Staff" wins over a hypothetical "Chief") as a whole word: the
 * mention must be preceded by start-of-string/whitespace and followed by
 * end-of-string/whitespace/punctuation, so "@Bot" inside "@BotFoo" doesn't
 * false-match. The matched "@BotB" token is replaced with the bare bot name
 * so the remaining text still reads as a natural instruction; if nothing is
 * left after that, it's not a delegation and falls through to a normal
 * message.
 */
export async function resolveDelegationTarget(
  tx: Prisma.TransactionClient,
  actor: Actor,
  originBotId: string,
  text: string | undefined,
): Promise<{ botId: string; botName: string; threadId: string; prompt: string } | null> {
  const trimmed = (text ?? "").trim();
  if (!trimmed.includes("@")) return null;
  const candidates = await tx.bot.findMany({
    where: { workspaceId: actor.workspaceId, archivedAt: null, id: { not: originBotId } },
    select: { id: true, name: true, thread: { select: { id: true } } },
  });
  const withThread = candidates
    .filter((candidate) => candidate.thread)
    .sort((a, b) => b.name.length - a.name.length);
  for (const candidate of withThread) {
    const pattern = new RegExp(`(^|\\s)@${escapeRegExp(candidate.name)}(?=$|[\\s.,!?;:])`, "i");
    if (!pattern.test(trimmed)) continue;
    const prompt = trimmed
      .replace(pattern, (_match, lead) => `${lead}${candidate.name}`)
      .replace(/\s+/g, " ")
      .trim();
    if (!prompt || prompt.toLowerCase() === candidate.name.toLowerCase()) continue;
    return { botId: candidate.id, botName: candidate.name, threadId: candidate.thread!.id, prompt };
  }
  return null;
}

async function buildDelegationContext(
  tx: Prisma.TransactionClient,
  threadId: string,
): Promise<string> {
  const recent = await tx.message.findMany({
    where: { threadId },
    orderBy: { seq: "desc" },
    take: DELEGATION_CONTEXT_MESSAGES,
    select: { role: true, blocks: true },
  });
  const lines = recent
    .reverse()
    .map((message) => {
      const text = blocksToAgentHistoryText(message.blocks as MessageBlock[]);
      return text ? `${message.role}: ${text}` : null;
    })
    .filter((line): line is string => Boolean(line));
  return lines.join("\n");
}

/**
 * Creates the delegated bot's own Task/Run (same create-then-enqueue shape as
 * routine wakeups and group handoffs) plus a "delegated_task" card message in
 * the origin thread that a later run.started/completed/failed hook mirrors
 * live status into (see notifyDelegationOrigin in packages/adapters).
 */
async function createDelegatedRun(
  tx: Prisma.TransactionClient,
  params: {
    actor: Actor;
    originBotId: string;
    originThreadId: string;
    targetBotId: string;
    targetBotName: string;
    targetThreadId: string;
    prompt: string;
  },
) {
  const context = await buildDelegationContext(tx, params.originThreadId);
  const enrichedPrompt = context
    ? `${params.prompt}\n\n(Delegated from another bot's conversation. Recent context:\n${context})`
    : params.prompt;

  const task = await tx.task.create({
    data: {
      workspaceId: params.actor.workspaceId,
      botId: params.targetBotId,
      threadId: params.targetThreadId,
      userId: params.actor.userId,
      prompt: enrichedPrompt,
      status: "queued",
    },
  });
  const run = await tx.run.create({
    data: {
      workspaceId: params.actor.workspaceId,
      botId: params.targetBotId,
      threadId: params.targetThreadId,
      taskId: task.id,
      userId: params.actor.userId,
      status: "queued",
      trigger: "spawn",
      delegatedFromThreadId: params.originThreadId,
    },
  });

  const cardBlock: MessageBlock = {
    kind: "delegated_task",
    taskId: task.id,
    runId: run.id,
    botId: params.targetBotId,
    botName: params.targetBotName,
    prompt: params.prompt,
    status: "queued",
    summary: null,
  };
  const cardMessage = await createThreadMessageInTransaction(tx, {
    threadId: params.originThreadId,
    role: "bot",
    botId: params.originBotId,
    blocks: [cardBlock],
  });
  await tx.run.update({
    where: { id: run.id },
    data: { delegatedFromMessageId: cardMessage.id },
  });

  return { run, cardMessageId: cardMessage.id, cardBlocks: [cardBlock] as MessageBlock[] };
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
  createdAt: Date;
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

        const delegated = await resolveDelegationTarget(tx, actor, target.botId, input.text);
        if (delegated) {
          const userEvent = await appendEventInTransaction(tx, {
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
          const created = await createDelegatedRun(tx, {
            actor,
            originBotId: target.botId,
            originThreadId: target.threadId,
            targetBotId: delegated.botId,
            targetBotName: delegated.botName,
            targetThreadId: delegated.threadId,
            prompt: delegated.prompt,
          });
          const cardEvent = await appendEventInTransaction(tx, {
            workspaceId: actor.workspaceId,
            threadId: target.threadId,
            botId: target.botId,
            type: "thread.message.created",
            payload: { messageId: created.cardMessageId, role: "bot", blocks: created.cardBlocks },
          });
          return { message, runs: [created.run], eventSeq: Math.max(userEvent.seq, cardEvent.seq) };
        }

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

/**
 * Cancels a single run, leaving any other active run on the same thread
 * untouched — unlike stopThreadRuns, which cancels every active run on the
 * thread at once. Needed so an accidental duplicate @mention delegation
 * (two Task/Run pairs queued on the same target bot) can be cleaned up
 * without killing the run that's actually meant to keep going.
 */
export async function cancelRun(
  deps: {
    prisma: PrismaClient;
    sandbox: import("@rakazo/adapter-kit").SandboxProvider;
    events: ThreadEvents;
  },
  actor: Actor,
  runId: string,
): Promise<{ ok: true } | { ok: false; reason: "not_found" | "not_active" }> {
  const run = await deps.prisma.run.findFirst({
    where: { id: runId, bot: { workspaceId: actor.workspaceId, userId: actor.userId } },
    select: {
      id: true,
      status: true,
      botId: true,
      workspaceId: true,
      delegatedFromThreadId: true,
      delegatedFromMessageId: true,
      bot: {
        select: {
          computer: {
            select: {
              id: true,
              homeKey: true,
              kind: true,
              providerRef: true,
              executionRunId: true,
            },
          },
        },
      },
    },
  });
  if (!run) return { ok: false, reason: "not_found" };
  if (!ACTIVE_RUN_STATUSES.includes(run.status as (typeof ACTIVE_RUN_STATUSES)[number])) {
    return { ok: false, reason: "not_active" };
  }
  await deps.prisma.run.update({
    where: { id: run.id },
    data: { status: "cancelled", completedAt: new Date() },
  });
  const computer = run.bot.computer;
  if (computer && computer.executionRunId === run.id) {
    await deps.prisma.computerExecutionLease.deleteMany({ where: { botId: run.botId } });
    await deps.prisma.computer.update({
      where: { id: computer.id },
      data: { executionRunId: null, executionBotId: null, executionLeaseExpiresAt: null },
    });
    if (computer.providerRef) {
      await deps.sandbox
        .releaseScreen?.(toComputerRef(computer), {
          operationId: "stop",
          traceId: "stop",
          workspaceId: actor.workspaceId,
          userId: actor.userId,
          botId: run.botId,
          signal: new AbortController().signal,
        })
        .catch(() => undefined);
    }
  }
  await deps.prisma.event.deleteMany({ where: { type: "thread.progress", runId: run.id } });
  await notifyDelegationOrigin(deps, run, "cancelled");
  return { ok: true };
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
