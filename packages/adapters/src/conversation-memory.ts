import type { SemanticMemoryConversationTurn, SemanticMemoryProvider } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { effectiveMemoryScope, isPartialReplyClientNonce, loadMessageAuthor } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { MemoryProviderResolver } from "./memory-provider-factory.js";
import { messageBlocksText } from "./run-replies.js";
import { isUserProgressClientNonce } from "./user-progress.js";

/** A person or another bot talking to the bot; routines, webhooks and channels are not. */
export const CONVERSATION_MEMORY_TRIGGERS: ReadonlySet<string> = new Set([
  "user",
  "messaging",
  "follow_up",
  "bot_message",
]);

/**
 * The bot's own direct thread and every group chat it takes part in: clearing either purges what
 * the bot learned there.
 */
export function retainsConversationTurn(input: {
  trigger: string;
  sourceMessageId: string | null;
  runBotId: string;
  threadBotId: string | null;
  threadGroupId: string | null;
  nonOwnerChatRun: boolean;
  provider: SemanticMemoryProvider | null;
}): boolean {
  return (
    input.provider?.retainConversation !== undefined &&
    !input.nonOwnerChatRun &&
    CONVERSATION_MEMORY_TRIGGERS.has(input.trigger) &&
    Boolean(input.sourceMessageId) &&
    (input.threadBotId === input.runBotId || input.threadGroupId !== null)
  );
}

/** At most this many group messages are sent for one turn. */
const MAX_GROUP_WINDOW_MESSAGES = 200;
/** Group transcript cap per turn, matching the group-chat window other agents use. */
const MAX_GROUP_WINDOW_CHARS = 32_000;
/** A single longer group message is cut to a marked excerpt of this many characters. */
const MAX_GROUP_MESSAGE_CHARS = 8_000;
const EXCERPT_MARKER = " […]";

type SaidMessage = {
  seq: number;
  blocks: unknown;
  createdAt: Date;
  role: "user" | "assistant";
  speaker?: string;
  text?: { content: string; speaker?: string };
};

/** Cuts text to its first `max` characters plus a marker, never splitting a surrogate pair. */
function excerpt(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}${EXCERPT_MARKER}`;
}

/**
 * Cuts oversized group messages, then keeps the newest that fit the transcript cap. This run's
 * replies are always kept.
 */
function capGroupWindow(messages: SaidMessage[]): SaidMessage[] {
  const withText = messages.map((message) => {
    const text = conversationText(message.blocks);
    return {
      ...message,
      text: { ...text, content: excerpt(text.content, MAX_GROUP_MESSAGE_CHARS) },
    };
  });
  let budget =
    MAX_GROUP_WINDOW_CHARS -
    withText
      .filter((message) => message.role === "assistant")
      .reduce((sum, message) => sum + message.text.content.length, 0);
  const newestFirst = [...withText].sort((a, b) => b.seq - a.seq);
  const kept: SaidMessage[] = [];
  let full = false;
  for (const message of newestFirst) {
    if (message.role === "assistant") {
      kept.push(message);
      continue;
    }
    if (full) continue;
    if (message.text.content.length > budget) {
      full = true;
      continue;
    }
    budget -= message.text.content.length;
    kept.push(message);
  }
  return kept;
}

type ReceivedBotMessage = Extract<MessageBlock, { kind: "bot_message_received" }>;

function receivedBotMessage(blocks: unknown): ReceivedBotMessage | undefined {
  return (blocks as MessageBlock[]).find(
    (block): block is ReceivedBotMessage => block.kind === "bot_message_received",
  );
}

/**
 * Of these runs, the ones that never read outside content. Another bot's words from a run that did
 * may repeat that outside text, which would come back later as this bot's trusted memory.
 */
async function runsWithoutOutsideContent(
  prisma: PrismaClient,
  runIds: readonly string[],
): Promise<Set<string>> {
  if (!runIds.length) return new Set();
  const runs = await prisma.run.findMany({
    where: { id: { in: [...new Set(runIds)] } },
    select: { id: true, readOutsideContent: true },
  });
  return new Set(runs.filter((run) => !run.readOutsideContent).map((run) => run.id));
}

/**
 * The run that sent a received bot message: the received block points at the sender's own copy
 * of the message, which belongs to the sending run.
 */
async function senderRunIds(
  prisma: PrismaClient,
  received: readonly ReceivedBotMessage[],
): Promise<Map<string, string>> {
  const outboundIds = [
    ...new Set(
      received.flatMap((block) => (block.returnToMessageId ? [block.returnToMessageId] : [])),
    ),
  ];
  if (!outboundIds.length) return new Map();
  const outbound = await prisma.message.findMany({
    where: { id: { in: outboundIds } },
    select: { id: true, runId: true },
  });
  return new Map(
    outbound.flatMap((message) => (message.runId ? [[message.id, message.runId] as const] : [])),
  );
}

/** Whether this received bot message came from a run that never read outside content. */
async function trustedSenderRun(
  prisma: PrismaClient,
  received: ReceivedBotMessage,
): Promise<boolean> {
  if (!received.returnToMessageId) return false;
  const runId = (await senderRunIds(prisma, [received])).get(received.returnToMessageId);
  return Boolean(runId && (await runsWithoutOutsideContent(prisma, [runId])).has(runId));
}

/**
 * Step and page ids, approval drafts and secret cards are not conversation. A message another bot
 * sent this bot is that bot's words.
 */
function conversationText(blocks: unknown): { content: string; speaker?: string } {
  const list = blocks as MessageBlock[];
  const received = receivedBotMessage(list);
  if (received) return { content: received.text.trim(), speaker: received.fromBotName };
  return { content: messageBlocksText(list).trim() };
}

/**
 * What the person sent while the run worked and the run claimed. Finalizing a completed run deletes
 * these claims, so read them first. Never throws: learning from a turn is optional.
 */
export async function answeredSteeringMessageIds(
  deps: { prisma: PrismaClient },
  runId: string,
): Promise<string[]> {
  try {
    const claims = await deps.prisma.steeringMessage.findMany({
      where: { runId, claimedAt: { not: null } },
      select: { messageId: true },
    });
    return claims.map((claim) => claim.messageId);
  } catch (error) {
    getLogger().error("memory.retain-turn could not read the run's answered messages", error);
    return [];
  }
}

export type RetainTurnResult = { pending?: { token: string; generation: number } };

/**
 * Sends one finished turn of a bot's conversation to the Space's memory provider. In the bot's
 * direct thread: the message that started the run, what was added while it worked, and the
 * replies. In a group chat: everything the room said since the bot last replied, and the replies.
 * `withoutReplies` leaves this run's replies out: the run took in outside content, and its replies
 * could carry that text into trusted memory. People's and other bots' words are still learned,
 * except words from another bot's run that read outside content.
 *
 * `pending` means the provider is still storing the turn: poll `settleRetainedConversation`
 * with it so a clear that lands meanwhile is purged once it settles.
 */
export async function retainRunConversation(
  deps: { prisma: PrismaClient; memoryProviders: MemoryProviderResolver },
  runId: string,
  answeredMessageIds: readonly string[] = [],
  options: { withoutReplies?: boolean } = {},
): Promise<RetainTurnResult> {
  const done: RetainTurnResult = {};
  const run = await deps.prisma.run.findUnique({
    where: { id: runId },
    select: {
      id: true,
      spaceId: true,
      botId: true,
      threadId: true,
      userId: true,
      sourceMessageId: true,
    },
  });
  if (!run?.sourceMessageId) return done;
  const thread = await deps.prisma.thread.findUnique({
    where: { id: run.threadId },
    select: { botId: true, groupId: true, historyCompactionGeneration: true },
  });
  if (!thread || (thread.botId !== run.botId && !thread.groupId)) return done;
  const inGroup = Boolean(thread.groupId);
  const configured = await deps.memoryProviders.resolve(run.spaceId);
  const provider = configured?.provider;
  if (!configured || !provider?.retainConversation) return done;
  const [source, steered, replies, bot] = await Promise.all([
    deps.prisma.message.findFirst({
      // In a group chat another bot's handoff can start the run.
      where: {
        id: run.sourceMessageId,
        threadId: run.threadId,
        ...(inGroup ? {} : { role: "user" }),
      },
      select: { id: true, seq: true, blocks: true, createdAt: true, authorUserId: true },
    }),
    answeredMessageIds.length && !inGroup
      ? deps.prisma.message.findMany({
          where: { id: { in: [...answeredMessageIds] }, threadId: run.threadId, role: "user" },
          select: { id: true, seq: true, blocks: true, createdAt: true },
        })
      : [],
    deps.prisma.message.findMany({
      where: { runId: run.id, threadId: run.threadId, role: "bot" },
      orderBy: { seq: "asc" },
      select: { seq: true, blocks: true, createdAt: true, clientNonce: true },
    }),
    deps.prisma.bot.findUnique({
      where: { id: run.botId },
      select: { name: true, memoryScope: true, userId: true },
    }),
  ]);
  // A cleared thread no longer has the message the turn answered.
  if (!source) return done;
  // Another owner's bot, or a bot in another Space, is outside text: learning its words would let
  // them come back later as this bot's own trusted memory.
  const received = receivedBotMessage(source.blocks);
  if (received) {
    const sender = await deps.prisma.bot.findUnique({
      where: { id: received.fromBotId },
      select: { spaceId: true, userId: true },
    });
    if (!sender || sender.spaceId !== run.spaceId || sender.userId !== bot?.userId) return done;
    // In a group chat the window below drops just that message.
    if (!inGroup && !(await trustedSenderRun(deps.prisma, received))) return done;
  }
  const author = await loadMessageAuthor(deps.prisma, source.authorUserId ?? run.userId);
  // Interim progress beats are status narration, and a partial reply was cut off by an error.
  const kept = replies.filter(
    (reply) =>
      !isPartialReplyClientNonce(reply.clientNonce) &&
      !isUserProgressClientNonce(reply.clientNonce),
  );
  const said: SaidMessage[] = [];
  if (inGroup) {
    // The window ends at this run's last reply, so a run that never replied has no turn.
    const lastReply = kept.at(-1);
    if (!lastReply) return done;
    const room = await groupWindow(deps.prisma, run, source.seq, lastReply.seq);
    said.push(
      ...capGroupWindow(
        options.withoutReplies ? room.filter((message) => message.role !== "assistant") : room,
      ),
    );
  } else {
    // Steering messages can be other bots' words too.
    const steeredReceived = steered.flatMap((message) => {
      const block = receivedBotMessage(message.blocks);
      return block ? [block] : [];
    });
    const steeredSenders = await senderRunIds(deps.prisma, steeredReceived);
    const trustedSteered = await runsWithoutOutsideContent(deps.prisma, [
      ...steeredSenders.values(),
    ]);
    said.push(
      { ...source, role: "user" },
      ...steered
        .filter((message) => {
          if (message.id === source.id) return false;
          const block = receivedBotMessage(message.blocks);
          const senderRun = block?.returnToMessageId && steeredSenders.get(block.returnToMessageId);
          return !block || Boolean(senderRun && trustedSteered.has(senderRun));
        })
        .map((message) => ({ ...message, role: "user" as const })),
      ...(options.withoutReplies
        ? []
        : kept.map((reply) => ({ ...reply, role: "assistant" as const }))),
    );
  }
  said.sort((a, b) => a.seq - b.seq);
  // In the order it happened, with consecutive messages from one speaker joined.
  const turns: SemanticMemoryConversationTurn[] = [];
  for (const message of said) {
    const text = message.text ?? conversationText(message.blocks);
    if (!text.content) continue;
    const speaker = message.speaker ?? text.speaker;
    const timestamp = message.createdAt.toISOString();
    const previous = turns.at(-1);
    if (previous?.role === message.role && previous.speaker === speaker) {
      previous.content = `${previous.content}\n\n${text.content}`;
      previous.timestamp = timestamp;
    } else {
      turns.push({
        role: message.role,
        content: text.content,
        timestamp,
        ...(speaker === undefined ? {} : { speaker }),
      });
    }
  }
  if (
    !turns.some((turn) => turn.role === "user") ||
    (!options.withoutReplies && !turns.some((turn) => turn.role === "assistant"))
  ) {
    return done;
  }
  const generation = thread.historyCompactionGeneration;
  const context = retainContext(run);
  const result = await provider.retainConversation(
    {
      botId: run.botId,
      botName: bot?.name || "the assistant",
      userName: author?.name || "the user",
      scope: effectiveMemoryScope(bot?.memoryScope ?? null, configured.defaultScope),
      threadId: run.threadId,
      conversation: thread.groupId ? "group" : "direct",
      generation,
      runId,
      turns,
    },
    context,
  );
  // Retrying is safe: the provider makes a repeated turn a no-op.
  if (!result.ok) throw new Error(result.error);
  if (result.value.pending) return { pending: { token: result.value.pending, generation } };
  await purgeIfCleared(deps.prisma, provider, run, generation, context);
  return {};
}

/**
 * Whether a turn the provider was still storing is stored now. Once it is, a clear that landed
 * meanwhile is purged. Runs outlive a clear, so this works after the turn's messages are gone.
 */
export async function settleRetainedConversation(
  deps: { prisma: PrismaClient; memoryProviders: MemoryProviderResolver },
  runId: string,
  pending: { token: string; generation: number },
): Promise<{ settled: boolean }> {
  const run = await deps.prisma.run.findUnique({
    where: { id: runId },
    select: { id: true, spaceId: true, botId: true, threadId: true, userId: true },
  });
  if (!run) return { settled: true };
  const provider = (await deps.memoryProviders.resolve(run.spaceId))?.provider;
  if (!provider) return { settled: true };
  const context = retainContext(run);
  if (provider.retainedConversationSettled) {
    const result = await provider.retainedConversationSettled(pending.token, context);
    if (!result.ok) throw new Error(result.error);
    if (!result.value.settled) return { settled: false };
  }
  await purgeIfCleared(deps.prisma, provider, run, pending.generation, context);
  return { settled: true };
}

type RetainRun = { id: string; spaceId: string; botId: string; threadId: string; userId: string };

function retainContext(run: RetainRun) {
  const operationId = `memory.retain-turn:${run.id}`;
  return {
    operationId,
    traceId: operationId,
    spaceId: run.spaceId,
    userId: run.userId,
    botId: run.botId,
    runId: run.id,
    signal: new AbortController().signal,
  };
}

/**
 * A clear can commit and purge while a turn is being stored; purge again so the late write cannot
 * leave cleared conversation data behind.
 */
async function purgeIfCleared(
  prisma: PrismaClient,
  provider: SemanticMemoryProvider,
  run: RetainRun,
  generation: number,
  context: ReturnType<typeof retainContext>,
): Promise<void> {
  const latest = await prisma.thread.findUnique({
    where: { id: run.threadId },
    select: { historyCompactionGeneration: true },
  });
  if (latest?.historyCompactionGeneration === generation) return;
  try {
    const removed = await provider.purgeHistory(
      { botId: run.botId, threadId: run.threadId, generations: [generation] },
      context,
    );
    if (!removed.ok) {
      getLogger().error(
        `memory.retain-turn could not purge a cleared conversation: ${removed.error}`,
      );
    }
  } catch (error) {
    getLogger().error("memory.retain-turn could not purge a cleared conversation", error);
  }
}

/**
 * What a group chat said from just after this bot's previous reply through this run's last reply:
 * people's messages, other bots' messages under their names, and this run's replies.
 */
async function groupWindow(
  prisma: PrismaClient,
  run: { id: string; botId: string; threadId: string },
  sourceSeq: number,
  lastReplySeq: number,
): Promise<SaidMessage[]> {
  const previousReply = await prisma.message.findFirst({
    where: {
      threadId: run.threadId,
      role: "bot",
      botId: run.botId,
      OR: [{ runId: null }, { runId: { not: run.id } }],
      seq: { lt: sourceSeq },
    },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  const recent = await prisma.message.findMany({
    where: {
      threadId: run.threadId,
      seq: { gt: previousReply?.seq ?? -1, lte: lastReplySeq },
      role: { in: ["user", "bot"] },
    },
    orderBy: { seq: "desc" },
    take: MAX_GROUP_WINDOW_MESSAGES,
    select: {
      seq: true,
      role: true,
      blocks: true,
      createdAt: true,
      botId: true,
      runId: true,
      clientNonce: true,
    },
  });
  const said = recent.filter(
    (message) =>
      message.role === "user" ||
      (!isPartialReplyClientNonce(message.clientNonce) &&
        !isUserProgressClientNonce(message.clientNonce) &&
        // This bot's words from another run belong to that run's turn.
        (message.botId !== run.botId || message.runId === run.id)),
  );
  // Another bot's words are learned only from a run that never read outside content: that text
  // would otherwise come back later as this bot's trusted memory.
  const received = said.flatMap((message) => {
    const block = message.role === "user" ? receivedBotMessage(message.blocks) : undefined;
    return block ? [block] : [];
  });
  const senders = await senderRunIds(prisma, received);
  const trusted = await runsWithoutOutsideContent(prisma, [
    ...said.flatMap((message) =>
      message.role === "bot" && message.botId !== run.botId && message.runId ? [message.runId] : [],
    ),
    ...senders.values(),
  ]);
  const messages = said.filter((message) => {
    if (message.role === "bot") {
      return message.botId === run.botId || Boolean(message.runId && trusted.has(message.runId));
    }
    const block = receivedBotMessage(message.blocks);
    const senderRun = block?.returnToMessageId && senders.get(block.returnToMessageId);
    return !block || Boolean(senderRun && trusted.has(senderRun));
  });
  const otherBotIds = [
    ...new Set(
      messages.flatMap((message) =>
        message.role === "bot" && message.botId && message.botId !== run.botId
          ? [message.botId]
          : [],
      ),
    ),
  ];
  const otherBots = otherBotIds.length
    ? await prisma.bot.findMany({
        where: { id: { in: otherBotIds } },
        select: { id: true, name: true },
      })
    : [];
  const names = new Map(otherBots.map((other) => [other.id, other.name]));
  return messages.map((message) => {
    if (message.role === "user") return { ...message, role: "user" as const };
    if (message.botId === run.botId) return { ...message, role: "assistant" as const };
    return {
      ...message,
      role: "user" as const,
      speaker: names.get(message.botId ?? "") || "another assistant",
    };
  });
}
