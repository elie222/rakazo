import { MessageBlock } from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  BOT_MESSAGE_MAX_LENGTH,
  BOT_MESSAGE_TOO_LONG,
  botMessageContext,
  botMessageHopExhausted,
  nextBotMessageHop,
  renderBotGroupDirectory,
  renderGroupMembersContext,
  resolveBotAddress,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  IsolationError,
  lockSpaceGroup,
  THREAD_LOCK_TRANSACTION_OPTIONS,
  touchGroupUpdatedAt,
} from "@rakazo/db";
import { runLeaseFor } from "../runs/assembly/run-messages.js";
import type { ExecutorDeps } from "../runs/executor/executor-deps.js";
import {
  outboundPilotDirective,
  outboundPilotEnrolled,
} from "../runs/turn/primary-outbound-handoff.js";
import {
  groupHandoffNonce,
  groupPilotEnrolled,
  groupPilotRuntimeForBot,
  handoffPilotRuntimeForBot,
  pilotHandoffSourceWhere,
  pilotLauncher,
  pilotRunModel,
} from "../runs/turn/primary-runtime-pilot.js";
import { wakeRun } from "../runs/wakeups/wake-run.js";

export async function handoffToGroupBot(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs" | "runLease">,
  run: {
    id: string;
    spaceId: string;
    threadId: string;
    botId: string;
    userId: string;
  },
  groupId: string,
  input: {
    bot_id?: string;
    confirm_name?: string;
    message: string;
    deliveryKey?: string;
    fromPrimaryPilot?: true;
    /** Saved attachments, shown on the handoff and copied to the next bot's computer. */
    files?: Array<Extract<MessageBlock, { kind: "image" | "file" }>>;
  },
) {
  const text = input.message.trim();
  if (!text) {
    return { error: `message must contain 1 to ${BOT_MESSAGE_MAX_LENGTH} characters` } as const;
  }
  if (text.length > BOT_MESSAGE_MAX_LENGTH) return { error: BOT_MESSAGE_TOO_LONG } as const;
  const committed = await deps.prisma.$transaction(async (tx) => {
    try {
      await lockSpaceGroup(tx, run, groupId);
    } catch (error) {
      if (error instanceof IsolationError)
        return { error: "group is no longer available" } as const;
      throw error;
    }
    const group = await tx.chatGroup.findFirst({
      where: { id: groupId, spaceId: run.spaceId, archivedAt: null },
      include: {
        thread: { select: { id: true } },
        members: {
          where: { bot: { archivedAt: null } },
          include: { bot: { select: { id: true, name: true } } },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    if (!group?.thread) return { error: "group is no longer available" } as const;
    const targetThreadId = group.thread.id;
    // Match message_bot's lock order and serialize source cancellation/clearing with delivery.
    for (const threadId of [...new Set([run.threadId, targetThreadId])].sort()) {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
    }
    const activeSource = await tx.run.findFirst({
      where: {
        id: run.id,
        spaceId: run.spaceId,
        threadId: run.threadId,
        botId: run.botId,
        userId: run.userId,
        status: "running",
      },
      select: {
        id: true,
        primaryRuntime: true,
        thread: { select: { groupId: true } },
        sourceMessage: { select: { blocks: true } },
      },
    });
    if (!activeSource) return { error: "source run is no longer active" } as const;
    const inGroup = targetThreadId === run.threadId;
    if (!inGroup && activeSource.thread.groupId) {
      return { error: "group handoffs must stay in the current group" } as const;
    }
    if (!group.members.some((member) => member.bot.id === run.botId)) {
      return { error: "source bot is no longer a group member" } as const;
    }

    const sourceRuntime = activeSource.primaryRuntime;
    const bots = group.members.map((member) => member.bot);
    if (input.fromPrimaryPilot) {
      const sender = bots.find((bot) => bot.id === run.botId);
      const original = MessageBlock.array().safeParse(activeSource.sourceMessage?.blocks);
      const [first] = original.success ? original.data : [];
      const authorized =
        sender && first?.kind === "text" && original.success && original.data.length === 1
          ? outboundPilotDirective(first.text, sender.name)
          : undefined;
      if (
        !sourceRuntime ||
        sourceRuntime !== groupPilotRuntimeForBot(run.botId) ||
        !outboundPilotEnrolled(run.botId) ||
        !inGroup ||
        input.files?.length ||
        !sender ||
        resolveBotAddress(bots, { name: sender.name })?.id !== run.botId ||
        !authorized ||
        authorized.recipient !== input.confirm_name ||
        !input.bot_id ||
        resolveBotAddress(bots, { name: authorized.recipient })?.id !== input.bot_id
      )
        return { error: "the owner did not authorize this pilot handoff" } as const;
    } else if (sourceRuntime) {
      return { error: "the source pilot does not have access to group handoff tools" } as const;
    }

    // A group stage has one owner; an outside turn can send several independent tasks.
    const deliveryKey = groupHandoffNonce(inGroup ? run.id : (input.deliveryKey ?? run.id));
    const existing = await tx.message.findUnique({
      where: { threadId_clientNonce: { threadId: targetThreadId, clientNonce: deliveryKey } },
      select: {
        id: true,
        sourceRuns: {
          orderBy: { createdAt: "asc" },
          take: 1,
          select: { id: true, botId: true },
        },
      },
    });
    if (existing) {
      const nextRun = existing.sourceRuns[0];
      const event = await tx.event.findFirst({
        where: {
          threadId: targetThreadId,
          type: "group.handoff",
          payload: { path: ["messageId"], equals: existing.id },
        },
        orderBy: { seq: "desc" },
        select: { seq: true },
      });
      if (!nextRun || !event || (input.fromPrimaryPilot && nextRun.botId !== input.bot_id))
        return { error: "recorded handoff does not match this request" } as const;
      return {
        ok: true,
        botId: nextRun.botId,
        runId: nextRun.id,
        eventSeq: event.seq,
        threadId: targetThreadId,
        inGroup,
        groupName: group.name,
      } as const;
    }

    const target = resolveBotAddress(bots, {
      botId: input.bot_id,
      name: input.confirm_name,
    });
    if (!target) return { error: "handoff target is not a group member" } as const;
    const targetId = target.id;
    if (targetId === run.botId) return { error: "cannot hand off to yourself" } as const;

    let sourceBlocks: MessageBlock[] = [];
    if (activeSource.sourceMessage) {
      const parsedSource = MessageBlock.array().safeParse(activeSource.sourceMessage.blocks);
      if (!parsedSource.success) {
        return { error: "cannot verify the group handoff chain" } as const;
      }
      sourceBlocks = parsedSource.data;
    }
    const sourceHandoff = sourceBlocks.find(
      (block): block is Extract<MessageBlock, { kind: "handoff" }> => block.kind === "handoff",
    );
    const hop = nextBotMessageHop(sourceHandoff?.hop ?? botMessageContext(sourceBlocks)?.hop);
    if (botMessageHopExhausted(hop)) {
      return {
        error:
          "group handoff limit reached for this chain; finish the current stage in the shared thread instead",
      } as const;
    }

    let pilotPin: ReturnType<typeof pilotRunModel>;
    if (input.fromPrimaryPilot && !outboundPilotEnrolled(targetId))
      return { error: "the selected bot is not available for this pilot handoff" } as const;
    if (input.fromPrimaryPilot || groupPilotEnrolled(targetId)) {
      const runtime = handoffPilotRuntimeForBot(targetId);
      if (!runtime || !pilotLauncher()) {
        return { error: "the receiving bot is not available for pilot handoffs" } as const;
      }
      if (!inGroup || hop !== 1 || input.files?.length) {
        return {
          error: "the receiving pilot only supports a first plain-text handoff in this group",
        } as const;
      }
      const source = await tx.run.findFirst({
        where: {
          ...pilotHandoffSourceWhere(run, sourceRuntime ?? null),
          id: run.id,
          status: "running",
        },
        select: { id: true },
      });
      const recipient = await tx.bot.findFirst({
        where: { id: targetId, spaceId: run.spaceId, userId: run.userId, archivedAt: null },
        select: { modelProvider: true, modelId: true, modelCredentialId: true },
      });
      if (!source || !recipient) {
        return {
          error: "pilot handoffs require a human-started group run and bots with the same owner",
        } as const;
      }
      pilotPin = pilotRunModel(runtime, recipient);
      if (!pilotPin) {
        return { error: "the receiving pilot bot needs an explicit API-key connection" } as const;
      }
      const activeTarget = await tx.run.findFirst({
        where: {
          threadId: targetThreadId,
          botId: targetId,
          status: { in: [...ACTIVE_RUN_STATUSES] },
        },
        select: { id: true },
      });
      if (activeTarget)
        return { error: "the receiving pilot bot already has an active turn" } as const;
    }

    const handoffBlock: MessageBlock = {
      kind: "handoff",
      fromBotId: run.botId,
      toBotId: targetId,
      text,
      hop,
    };
    const message = await createThreadMessageInTransaction(tx, {
      threadId: targetThreadId,
      role: "bot",
      blocks: [handoffBlock, ...(input.files ?? [])],
      botId: run.botId,
      runId: inGroup ? run.id : undefined,
      clientNonce: deliveryKey,
      lease: inGroup ? runLeaseFor(deps, run.id) : undefined,
    });
    const task = await tx.task.create({
      data: {
        spaceId: run.spaceId,
        botId: targetId,
        threadId: targetThreadId,
        userId: run.userId,
        prompt: text,
        status: "queued",
      },
    });
    const nextRun = await tx.run.create({
      data: {
        spaceId: run.spaceId,
        botId: targetId,
        threadId: targetThreadId,
        taskId: task.id,
        userId: run.userId,
        status: "queued",
        trigger: "follow_up",
        sourceMessageId: message.id,
        ...pilotPin,
      },
    });
    const event = await appendEventInTransaction(tx, {
      spaceId: run.spaceId,
      threadId: targetThreadId,
      botId: run.botId,
      type: "group.handoff",
      runId: inGroup ? run.id : undefined,
      lease: inGroup ? runLeaseFor(deps, run.id) : undefined,
      payload: {
        messageId: message.id,
        fromBotId: run.botId,
        toBotId: targetId,
        text,
      },
    });
    await touchGroupUpdatedAt(tx, groupId);
    return {
      ok: true,
      botId: targetId,
      runId: nextRun.id,
      eventSeq: event.seq,
      threadId: targetThreadId,
      inGroup,
      groupName: group.name,
    } as const;
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
  if ("error" in committed) return committed;
  await deps.events.notify(committed.threadId, committed.eventSeq);
  await wakeRun(deps.jobs, committed.runId);
  return {
    ok: true,
    botId: committed.botId,
    runId: committed.runId,
    groupId,
    groupName: committed.groupName,
    note: committed.inGroup
      ? "Handoff recorded. End this turn without narrating it; the next bot owns the next stage."
      : "Handoff recorded in the selected group. The next bot will reply there. Continue any independent work.",
  };
}

export async function loadGroupContext(
  prisma: PrismaClient,
  groupId: string,
  self: { id: string; name: string },
  sharedSpace = false,
): Promise<string | undefined> {
  const group = await prisma.chatGroup.findUnique({
    where: { id: groupId },
    include: {
      members: {
        where: { bot: { archivedAt: null } },
        include: {
          bot: { select: { id: true, name: true, description: true } },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!group) return undefined;
  return renderGroupMembersContext(
    group.name,
    group.members.map((member) => member.bot),
    self,
    sharedSpace,
  );
}

/** Only the current bot's active groups in its space are discoverable. */
export async function loadBotGroupDirectory(
  prisma: PrismaClient,
  actor: { botId: string; spaceId: string },
): Promise<string | undefined> {
  const groups = await prisma.chatGroup.findMany({
    where: {
      spaceId: actor.spaceId,
      archivedAt: null,
      members: { some: { botId: actor.botId, bot: { archivedAt: null } } },
      thread: { isNot: null },
    },
    select: {
      id: true,
      name: true,
      members: {
        where: { bot: { archivedAt: null } },
        select: { bot: { select: { id: true, name: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
    orderBy: { createdAt: "asc" },
    take: 40,
  });
  return renderBotGroupDirectory(
    groups.map((group) => ({
      id: group.id,
      name: group.name,
      members: group.members.map((member) => member.bot),
    })),
  );
}
