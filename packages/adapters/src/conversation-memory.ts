import type { SemanticMemoryConversationTurn, SemanticMemoryProvider } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  effectiveMemoryScope,
  isPartialReplyClientNonce,
  loadMessageAuthor,
  loadMessageAuthors,
} from "@rakazo/db";
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
  authorUserId?: string | null;
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
 * replies take at most half of it, newest first, so long replies never crowd out what the room
 * said; everyone else's messages get the rest.
 */
function capGroupWindow(messages: SaidMessage[]): SaidMessage[] {
  const newestFirst = messages
    .map((message) => {
      const text = conversationText(message.blocks);
      return {
        ...message,
        text: { ...text, content: excerpt(text.content, MAX_GROUP_MESSAGE_CHARS) },
      };
    })
    .sort((a, b) => b.seq - a.seq);
  const keepNewest = (role: SaidMessage["role"], budget: number) => {
    const kept: SaidMessage[] = [];
    let used = 0;
    for (const message of newestFirst) {
      if (message.role !== role) continue;
      if (used + message.text.content.length > budget) break;
      used += message.text.content.length;
      kept.push(message);
    }
    return { kept, used };
  };
  const replies = keepNewest("assistant", MAX_GROUP_WINDOW_CHARS / 2);
  return [...replies.kept, ...keepNewest("user", MAX_GROUP_WINDOW_CHARS - replies.used).kept];
}

type ReceivedBotMessage = Extract<MessageBlock, { kind: "bot_message_received" }>;

function receivedBotMessage(blocks: unknown): ReceivedBotMessage | undefined {
  return (blocks as MessageBlock[]).find(
    (block): block is ReceivedBotMessage => block.kind === "bot_message_received",
  );
}

/** The bot whose memory another bot's words would enter. */
export type WordsReceiver = { spaceId: string; userId: string };

/** Whether a bot shares the receiver's Space and owner; any other bot's words are outside text. */
function receiverOwns(bot: { spaceId: string; userId: string }, receiver: WordsReceiver) {
  return bot.spaceId === receiver.spaceId && bot.userId === receiver.userId;
}

/**
 * Of the runs that wrote other bots' group replies, the ones whose words the receiver may treat
 * as its own trusted memory: the run's bot is in the receiver's Space and has its owner, and the
 * run completed without taking in outside content. A group reply is written when its run
 * finalizes, and the flag is final only then, so a running, waiting, failed or cancelled run is
 * not trusted, and neither is a run that can't be found.
 */
export async function trustedBotRuns(
  prisma: PrismaClient,
  receiver: WordsReceiver,
  runIds: readonly string[],
): Promise<Set<string>> {
  if (!runIds.length) return new Set();
  const runs = await prisma.run.findMany({
    where: { id: { in: [...new Set(runIds)] } },
    select: {
      id: true,
      status: true,
      readOutsideContent: true,
      bot: { select: { spaceId: true, userId: true } },
    },
  });
  return new Set(
    runs
      .filter(
        (run) =>
          run.status === "completed" && !run.readOutsideContent && receiverOwns(run.bot, receiver),
      )
      .map((run) => run.id),
  );
}

/**
 * Check new sources in history, not the receiver's own saved replies. Propagating a run's flag
 * through its own replies would permanently flag every subsequent turn after one outside read.
 */
export async function historyHasOutsideContent(
  prisma: PrismaClient,
  receiver: WordsReceiver & { botId: string },
  messages: readonly {
    role: string;
    botId?: string | null;
    runId: string | null;
    blocks: unknown;
  }[],
): Promise<boolean> {
  try {
    const received = messages.flatMap((message) => {
      const block = receivedBotMessage(message.blocks);
      return block ? [block] : [];
    });
    const replies = messages.filter(
      (message) => message.role === "bot" && message.botId !== receiver.botId,
    );
    const [trustedReplies, trustedReceived] = await Promise.all([
      trustedBotRuns(
        prisma,
        receiver,
        replies.flatMap((reply) => (reply.runId ? [reply.runId] : [])),
      ),
      trustedReceivedMessages(prisma, receiver, received),
    ]);
    return (
      received.some((block) => !trustedReceived.has(block)) ||
      replies.some((reply) => !reply.runId || !trustedReplies.has(reply.runId)) ||
      messages.some((message) =>
        (message.blocks as MessageBlock[]).some((block) => block.kind === "channel_message"),
      )
    );
  } catch {
    return true;
  }
}

/**
 * Of these messages other bots sent the receiver, the ones it may treat as its own trusted
 * memory: the sending bot is in the receiver's Space and has its owner, and the sending run had
 * taken in no outside content when it sent the message (`senderClean`). A message can only repeat
 * what its run read before sending it, so that snapshot is exact. A message without the marker,
 * including any sent before it existed, is not trusted.
 */
async function trustedReceivedMessages(
  prisma: PrismaClient,
  receiver: WordsReceiver,
  received: readonly ReceivedBotMessage[],
): Promise<Set<ReceivedBotMessage>> {
  const clean = received.filter((block) => block.senderClean === true);
  if (!clean.length) return new Set();
  const senders = await prisma.bot.findMany({
    where: { id: { in: [...new Set(clean.map((block) => block.fromBotId))] } },
    select: { id: true, spaceId: true, userId: true },
  });
  const owned = new Set(
    senders.filter((sender) => receiverOwns(sender, receiver)).map((sender) => sender.id),
  );
  return new Set(clean.filter((block) => owned.has(block.fromBotId)));
}

/** Whether the receiver may trust this message another bot sent it; see trustedReceivedMessages. */
export async function receivedBotMessageTrusted(
  prisma: PrismaClient,
  receiver: WordsReceiver,
  received: ReceivedBotMessage,
): Promise<boolean> {
  return (await trustedReceivedMessages(prisma, receiver, [received])).has(received);
}

/**
 * Whether the bot message that started a run may carry outside content: the bot whose chat it
 * arrived in may not trust it (see trustedReceivedMessages).
 */
export async function botMessageFromOutsideContent(
  prisma: PrismaClient,
  sourceMessageId: string,
): Promise<boolean> {
  const source = await prisma.message.findUnique({
    where: { id: sourceMessageId },
    select: {
      blocks: true,
      thread: { select: { spaceId: true, bot: { select: { userId: true } } } },
    },
  });
  const received = source ? receivedBotMessage(source.blocks) : undefined;
  if (!source || !received) return false;
  // Bot messages arrive in the receiving bot's own chat.
  const owner = source.thread.bot?.userId;
  return (
    !owner ||
    !(await receivedBotMessageTrusted(
      prisma,
      { spaceId: source.thread.spaceId, userId: owner },
      received,
    ))
  );
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

type RetainDeps = { prisma: PrismaClient; memoryProviders: MemoryProviderResolver };

export type RetainTurnResult = { pending?: { token?: string; generation: number } };

/**
 * Sends one finished turn of a bot's conversation to the Space's memory provider. In the bot's
 * direct thread: the message that started the run, what was added while it worked, and the
 * replies. In a group chat: everything the room said since the bot last replied, and the replies.
 * `withoutReplies` leaves this run's replies out: the run took in outside content, and its replies
 * could carry that text into trusted memory. People's and other bots' words are still learned,
 * except other bots' words this bot may not trust (see trustedReceivedMessages and
 * trustedBotRuns).
 *
 * `pending` means the provider is still storing the turn, or a clear landed meanwhile and its
 * purge failed: poll `settleRetainedConversation` with it so the clear is purged once it settles.
 */
export async function retainRunConversation(
  deps: RetainDeps,
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
          select: { id: true, seq: true, blocks: true, createdAt: true, authorUserId: true },
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
  if (!source || !bot) return done;
  const receiver: WordsReceiver = { spaceId: run.spaceId, userId: bot.userId };
  // Another bot's untrusted words (see trustedReceivedMessages) would come back later as this
  // bot's own trusted memory. In a group chat the window below drops just that message.
  const received = receivedBotMessage(source.blocks);
  if (received && !inGroup && !(await receivedBotMessageTrusted(deps.prisma, receiver, received))) {
    return done;
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
    const room = await groupWindow(deps.prisma, run, receiver, source.seq, lastReply.seq);
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
    const trustedSteered = await trustedReceivedMessages(deps.prisma, receiver, steeredReceived);
    said.push(
      { ...source, role: "user" },
      ...steered
        .filter((message) => {
          if (message.id === source.id) return false;
          const block = receivedBotMessage(message.blocks);
          return !block || trustedSteered.has(block);
        })
        .map((message) => ({ ...message, role: "user" as const })),
      ...(options.withoutReplies
        ? []
        : kept.map((reply) => ({ ...reply, role: "assistant" as const }))),
    );
  }
  // Keep different people's words separate instead of attributing the whole turn to its starter.
  const humans = said.filter(
    (message) => message.role === "user" && !receivedBotMessage(message.blocks) && !message.speaker,
  );
  const authorIds = [
    ...new Set([
      source.authorUserId ?? run.userId,
      ...humans.flatMap((message) => (message.authorUserId ? [message.authorUserId] : [])),
    ]),
  ];
  if (authorIds.length > 1) {
    const authors = await loadMessageAuthors(deps.prisma, authorIds);
    for (const message of humans) {
      message.speaker = message.authorUserId
        ? authors.get(message.authorUserId)?.name || "another person"
        : "another person";
    }
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
      botName: bot.name || "the assistant",
      userName: author?.name || "the user",
      scope: effectiveMemoryScope(bot.memoryScope, configured.defaultScope),
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
  try {
    await purgeIfCleared(deps.prisma, provider, run, generation, context);
  } catch (error) {
    // A retry would rebuild the turn from messages the clear deleted, and skip it: hand back the
    // stored generation so a later check purges it.
    getLogger().error("memory.retain-turn could not purge a cleared conversation", error);
    return { pending: { generation } };
  }
  return done;
}

/**
 * Whether a turn the provider was still storing is stored now. Once it is, a clear that landed
 * meanwhile is purged; a failed purge throws so the check runs again. Without a token the turn
 * is already stored and only the purge is left. Runs outlive a clear, so this works after the
 * turn's messages are gone.
 */
export async function settleRetainedConversation(
  deps: RetainDeps,
  runId: string,
  pending: { token?: string; generation: number },
): Promise<{ settled: boolean }> {
  const found = await retainedRunProvider(deps, runId);
  if (!found) return { settled: true };
  const { run, provider } = found;
  const context = retainContext(run);
  if (pending.token && provider.retainedConversationSettled) {
    const result = await provider.retainedConversationSettled(pending.token, context);
    if (!result.ok) throw new Error(result.error);
    if (!result.value.settled) return { settled: false };
  }
  await purgeIfCleared(deps.prisma, provider, run, pending.generation, context);
  return { settled: true };
}

/**
 * Stops waiting for a turn the provider never finished storing. If the chat was cleared
 * meanwhile, purge its generation once more: the write may have landed after the clear's purge.
 * Best effort, since nothing checks again after this.
 */
export async function abandonRetainedConversation(
  deps: RetainDeps,
  runId: string,
  pending: { generation: number },
): Promise<void> {
  try {
    const found = await retainedRunProvider(deps, runId);
    if (!found) return;
    const { run, provider } = found;
    await purgeIfCleared(deps.prisma, provider, run, pending.generation, retainContext(run));
  } catch (error) {
    getLogger().error("memory.retain-turn could not purge a cleared conversation", error);
  }
}

async function retainedRunProvider(
  deps: RetainDeps,
  runId: string,
): Promise<{ run: RetainRun; provider: SemanticMemoryProvider } | undefined> {
  const run = await deps.prisma.run.findUnique({
    where: { id: runId },
    select: { id: true, spaceId: true, botId: true, threadId: true, userId: true },
  });
  if (!run) return undefined;
  const provider = (await deps.memoryProviders.resolve(run.spaceId))?.provider;
  return provider ? { run, provider } : undefined;
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
 * leave cleared conversation data behind. Throws when the purge fails, so the caller retries.
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
  const removed = await provider.purgeHistory(
    { botId: run.botId, threadId: run.threadId, generations: [generation] },
    context,
  );
  if (!removed.ok) {
    throw new Error(`memory.retain-turn could not purge a cleared conversation: ${removed.error}`);
  }
}

/**
 * What a group chat said from just after this bot's previous reply through this run's last reply:
 * people's messages, other bots' messages under their names, and this run's replies.
 */
async function groupWindow(
  prisma: PrismaClient,
  run: { id: string; botId: string; threadId: string },
  receiver: WordsReceiver,
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
      authorUserId: true,
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
  // Another bot's words are learned only when this bot may trust them: its group replies by
  // their runs (see trustedBotRuns), messages it sent this bot by their marker.
  const received = said.flatMap((message) => {
    const block = message.role === "user" ? receivedBotMessage(message.blocks) : undefined;
    return block ? [block] : [];
  });
  const [trustedRuns, trustedReceived] = await Promise.all([
    trustedBotRuns(
      prisma,
      receiver,
      said.flatMap((message) =>
        message.role === "bot" && message.botId !== run.botId && message.runId
          ? [message.runId]
          : [],
      ),
    ),
    trustedReceivedMessages(prisma, receiver, received),
  ]);
  const messages = said.filter((message) => {
    if (message.role === "bot") {
      return (
        message.botId === run.botId || Boolean(message.runId && trustedRuns.has(message.runId))
      );
    }
    const block = receivedBotMessage(message.blocks);
    return !block || trustedReceived.has(block);
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
